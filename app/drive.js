/* Drive access for the browser.
 *
 * Nothing here is addressed by a hard-coded id. The root folder is found by
 * name after sign-in and everything below it is resolved relative to that, so
 * the public repo never carries a pointer to private content. Resolved ids are
 * memoised in localStorage because the lookups are the slowest part of a cold
 * start, and re-validated cheaply whenever a lookup misses.
 */
import { Config, LS } from './config.js'
import { GAuth }      from './gauth.js'

const FILES  = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

// name -> id, within a session
const memo = new Map()

function cacheKey(parentId, name) { return `id:${parentId}:${name}` }

async function q(query, fields = 'files(id,name,mimeType,modifiedTime)') {
  const url = `${FILES}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}` +
              `&pageSize=1000&supportsAllDrives=true`
  const r = await GAuth.fetch(url)
  if (!r.ok) throw new Error(`Drive query failed (${r.status})`)
  return (await r.json()).files ?? []
}

/** Find a child by name under a parent ('root' for My Drive). Cached. */
export async function findChild(parentId, name) {
  const k = cacheKey(parentId, name)
  if (memo.has(k)) return memo.get(k)
  const cached = LS.get(k)
  if (cached) { memo.set(k, cached); return cached }

  const files = await q(`name='${esc(name)}' and '${parentId}' in parents and trashed=false`)
  const id = files[0]?.id ?? null
  if (id) { memo.set(k, id); LS.set(k, id) }
  return id
}

/** The hub's root folder id. Throws a legible error if it isn't there. */
export async function rootId() {
  const id = await findChild('root', Config.rootFolderName)
  if (!id) {
    throw new Error(
      `No Drive folder named "${Config.rootFolderName}" on this account. ` +
      `Either you signed in with the wrong Google account, or the content has ` +
      `not been migrated yet (see tools/migrate.mjs).`
    )
  }
  return id
}

export async function moduleFolderId(mod) {
  const id = await findChild(await rootId(), mod)
  if (!id) throw new Error(`Module "${mod}" has no folder in Drive yet.`)
  return id
}

/** Read a JSON file that lives directly in a module's folder. */
export async function readModuleJson(mod, name, fallback = {}) {
  try {
    const folder = await moduleFolderId(mod)
    const id = await findChild(folder, name)
    if (!id) return fallback
    return await readJsonById(id, fallback)
  } catch { return fallback }
}

export async function readJsonById(fileId, fallback = {}) {
  const r = await GAuth.fetch(`${FILES}/${fileId}?alt=media&supportsAllDrives=true`)
  if (!r.ok) return fallback
  try { return await r.json() } catch { return fallback }
}

/** Fetch a Drive file's raw bytes. */
export async function readBlobById(fileId) {
  const r = await GAuth.fetch(`${FILES}/${fileId}?alt=media&supportsAllDrives=true`)
  if (!r.ok) throw new Error(`Drive fetch failed (${r.status})`)
  return r.blob()
}

export async function readTextById(fileId) {
  const r = await GAuth.fetch(`${FILES}/${fileId}?alt=media&supportsAllDrives=true`)
  if (!r.ok) throw new Error(`Drive fetch failed (${r.status})`)
  return r.text()
}

/**
 * Replace a module JSON file's contents in place, creating it if absent.
 * Updating (rather than re-creating) keeps the file id stable so cached ids and
 * anything referencing the file stay valid.
 */
export async function writeModuleJson(mod, name, data) {
  const folder = await moduleFolderId(mod)
  const body   = JSON.stringify(data)
  let id = await findChild(folder, name)

  if (id) {
    const r = await GAuth.fetch(
      `${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
    if (!r.ok) throw new Error(`Saving ${name} failed (${r.status})`)
    return id
  }
  return createFile(folder, name, new Blob([body], { type: 'application/json' }))
}

/** Multipart create — used for new JSON files and for pasted images. */
export async function createFile(parentId, name, blob) {
  const boundary = 'sysdsg_' + Math.random().toString(36).slice(2)
  const meta = { name, parents: [parentId] }
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(meta),
    `\r\n--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ])
  const r = await GAuth.fetch(
    `${UPLOAD}?uploadType=multipart&fields=id&supportsAllDrives=true`,
    { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
  if (!r.ok) throw new Error(`Upload failed (${r.status})`)
  const { id } = await r.json()
  memo.set(cacheKey(parentId, name), id)
  return id
}

/** Get-or-create a subfolder (used for images/ on first paste). */
export async function ensureFolder(parentId, name) {
  const found = await findChild(parentId, name)
  if (found) return found
  const r = await GAuth.fetch(`${FILES}?fields=id&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  if (!r.ok) throw new Error(`Creating folder ${name} failed (${r.status})`)
  const { id } = await r.json()
  memo.set(cacheKey(parentId, name), id)
  LS.set(cacheKey(parentId, name), id)
  return id
}

/** Forget every cached id — used when a lookup unexpectedly 404s. */
export function clearIdCache() {
  memo.clear()
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith(Config.ns + 'id:')) localStorage.removeItem(k)
  }
}
