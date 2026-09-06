// Thin, idempotent Drive helpers for migration.
//
// Every operation is keyed on (parentId, name) so a re-run adopts what is
// already there instead of creating duplicates — the migration is resumable
// and safe to run repeatedly.
import { createReadStream } from 'node:fs'
import { stat }             from 'node:fs/promises'
import { google }           from 'googleapis'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export function driveClient(auth) { return google.drive({ version: 'v3', auth }) }
export function sheetsClient(auth) { return google.sheets({ version: 'v4', auth }) }

const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Google's Drive endpoints return transient 5xx and rate-limit errors during a
 * long bulk upload — a 1,400-file migration reliably trips at least one. Every
 * call is wrapped so those retry with exponential backoff instead of aborting
 * the run. Genuine failures (404, 403, bad request) are re-thrown immediately.
 */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504])
const NET_ERRORS = /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up/i

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function withRetry(label, fn, tries = 6) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) {
      const code = e?.code ?? e?.response?.status ?? e?.status
      const retryable = TRANSIENT.has(Number(code)) || NET_ERRORS.test(e?.message ?? '')
      if (!retryable || i === tries - 1) throw e
      lastErr = e
      const wait = Math.min(30000, 2 ** i * 700) + Math.random() * 400
      console.log(`     retry ${label} after ${code ?? 'network'} — waiting ${(wait / 1000).toFixed(1)}s`)
      await sleep(wait)
    }
  }
  throw lastErr
}

/** Find one child of `parentId` by exact name. Returns {id,mimeType} or null. */
export async function findChild(drive, parentId, name) {
  // A null/absent parent means "My Drive root", which Drive addresses by the
  // alias 'root' — interpolating a null here would query for a folder literally
  // named null and fail with "File not found: .".
  const parent = parentId ?? 'root'
  const q = `name='${esc(name)}' and '${parent}' in parents and trashed=false`
  const { data } = await withRetry(`find ${name}`, () => drive.files.list({
    q, fields: 'files(id,name,mimeType,md5Checksum,size)', pageSize: 1,
    supportsAllDrives: true,
  }))
  return data.files?.[0] ?? null
}

/** Get-or-create a folder. Idempotent. */
export async function ensureFolder(drive, parentId, name) {
  const found = await findChild(drive, parentId, name)
  if (found) {
    if (found.mimeType !== FOLDER_MIME) {
      throw new Error(`Drive: "${name}" exists in ${parentId} but is not a folder`)
    }
    return found.id
  }
  const { data } = await withRetry(`mkdir ${name}`, () => drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId ?? 'root'] },
    fields: 'id',
  }))
  return data.id
}

/** List every child of a folder (handles pagination). */
export async function listChildren(drive, parentId) {
  const out = []
  let pageToken
  do {
    const { data } = await withRetry('list', () => drive.files.list({
      q: `'${parentId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,size)',
      pageSize: 1000, pageToken,
    }))
    out.push(...(data.files ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Create-or-update a file from a local path. If a file of that name already
 * exists in the folder and its md5 matches, it is left untouched (so re-runs
 * are cheap); otherwise its content is replaced in place, which keeps the file
 * id — and therefore every reference to it — stable.
 */
export async function upsertFile(drive, parentId, name, localPath, mimeType, md5) {
  const existing = await findChild(drive, parentId, name)
  if (existing && md5 && existing.md5Checksum === md5) {
    return { id: existing.id, skipped: true }
  }
  // A read stream is consumed on the first attempt, so it is recreated per try.
  const media = () => ({ mimeType, body: createReadStream(localPath) })
  if (existing) {
    const { data } = await withRetry(`update ${name}`,
      () => drive.files.update({ fileId: existing.id, media: media(), fields: 'id' }))
    return { id: data.id, updated: true }
  }
  const { data } = await withRetry(`upload ${name}`,
    () => drive.files.create({ requestBody: { name, parents: [parentId] }, media: media(), fields: 'id' }))
  return { id: data.id, created: true }
}

/** Create-or-update a file from an in-memory string. */
export async function upsertText(drive, parentId, name, text, mimeType = 'application/json') {
  const existing = await findChild(drive, parentId, name)
  const media = { mimeType, body: text }
  if (existing) {
    const { data } = await withRetry(`update ${name}`,
      () => drive.files.update({ fileId: existing.id, media, fields: 'id' }))
    return { id: data.id, updated: true }
  }
  const { data } = await withRetry(`create ${name}`,
    () => drive.files.create({ requestBody: { name, parents: [parentId] }, media, fields: 'id' }))
  return { id: data.id, created: true }
}

/** Get-or-create a Google Sheet by name inside a folder. */
export async function ensureSheet(drive, parentId, name) {
  const found = await findChild(drive, parentId, name)
  if (found) return found.id
  const { data } = await withRetry(`sheet ${name}`, () => drive.files.create({
    requestBody: {
      name, parents: [parentId],
      mimeType: 'application/vnd.google-apps.spreadsheet',
    },
    fields: 'id',
  }))
  return data.id
}

export async function fileSize(p) { return (await stat(p)).size }
