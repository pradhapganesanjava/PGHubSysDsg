#!/usr/bin/env node
/**
 * Verify what actually landed in Drive against what is on disk.
 *
 * The migration reports what it uploaded; this independently reads it back and
 * checks it is complete and correctly shaped — the same reads the browser will
 * make, so a pass here means the app has what it needs.
 *
 *   node tools/verify.mjs              every migrated module
 *   node tools/verify.mjs 01-foundations
 *   node tools/verify.mjs --write      also round-trip a write (notes.json)
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join }     from 'node:path'
import { fileURLToPath }     from 'node:url'

import { authorize } from './lib/auth.mjs'
import { driveClient, findChild, listChildren, withRetry } from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..')

const argv     = process.argv.slice(2)
const DO_WRITE = argv.includes('--write')
const only     = argv.filter(a => !a.startsWith('--'))

let pass = 0, fail = 0, skip = 0
const ok   = m => { pass++; console.log(`     \x1b[32m✓\x1b[0m ${m}`) }
const bad  = m => { fail++; console.log(`     \x1b[31m✗\x1b[0m ${m}`) }
const meh  = m => { skip++; console.log(`     \x1b[33m–\x1b[0m ${m}`) }

async function getJson(drive, fileId) {
  const r = await withRetry('download', () =>
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' }))
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data
}

async function localJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback }
}

async function main() {
  const auth  = await authorize()
  const drive = driveClient(auth)
  const state = await localJson(join(__dir, '.migration-state.json'), null)
  if (!state?.rootId) {
    console.error('\n  No tools/.migration-state.json — run the migration first.\n')
    process.exit(1)
  }

  const hub = await localJson(join(REPO, 'hub.json'), { modules: {} })
  const modules = only.length ? only : Object.keys(state.modules ?? {})

  console.log(`\n  Verifying Drive contents (root ${state.rootId})\n`)

  // ── root-level files ───────────────────────────────────────────────────────
  console.log('  root')
  for (const name of ['hub.json', 'hub-index.json']) {
    const id = await findChild(drive, state.rootId, name)
    if (!id) { name === 'hub.json' ? bad(`${name} missing`) : meh(`${name} missing (re-run migrate)`); continue }
    try {
      const data = await getJson(drive, id.id)
      if (name === 'hub.json') {
        const n = Object.keys(data.modules ?? {}).length
        n === Object.keys(hub.modules).length
          ? ok(`hub.json — ${n} modules`)
          : bad(`hub.json — ${n} modules, expected ${Object.keys(hub.modules).length}`)
      } else {
        const items = (data.modules ?? []).reduce(
          (a, m) => a + m.terms.length + m.qa.length + m.topics.length, 0)
        ok(`hub-index.json — ${data.modules?.length ?? 0} modules, ${items} items`)
      }
    } catch (e) { bad(`${name} unreadable: ${e.message}`) }
  }

  // ── per module ─────────────────────────────────────────────────────────────
  for (const m of modules) {
    const ms = state.modules?.[m]
    if (!ms?.folderId) { console.log(`\n  ${m}\n`); meh('not migrated yet'); continue }
    console.log(`\n  ${m}`)

    // data files match what is on disk
    for (const f of ['terms.json', 'qa.json', 'topics.json', 'notes.json', 'docs.json']) {
      const id = ms.data?.[f]
      if (!id) { meh(`${f} — no id recorded`); continue }
      try {
        const remote = await getJson(drive, id)
        const local  = await localJson(join(REPO, m, f), {})
        const rn = Object.keys(remote).length, ln = Object.keys(local).length
        rn === ln ? ok(`${f.padEnd(12)} ${rn} entries`)
                  : bad(`${f.padEnd(12)} ${rn} in Drive, ${ln} on disk`)
      } catch (e) { bad(`${f} unreadable: ${e.message}`) }
    }

    // docs index: every entry must resolve to an uploaded file
    if (ms.data?.['docs-index.json']) {
      try {
        const idx = await getJson(drive, ms.data['docs-index.json'])
        const missing = idx.filter(d => !d.driveId)
        missing.length ? bad(`docs-index    ${idx.length} docs, ${missing.length} without a Drive id`)
                       : ok(`docs-index    ${idx.length} docs, all with Drive ids`)
      } catch (e) { bad(`docs-index unreadable: ${e.message}`) }
    } else meh('docs-index    not uploaded')

    // Uploaded doc count matches the local folder. Compared at the top level
    // only, and files against files: a docs/ tree can contain real
    // subdirectories (05-backend/docs/transcripts/), which are mirrored as
    // Drive folders, so counting them together would never agree.
    const FOLDER = 'application/vnd.google-apps.folder'
    const docsFolder = await findChild(drive, ms.folderId, 'docs')
    if (docsFolder) {
      const remote = await listChildren(drive, docsFolder.id)
      const remoteFiles = remote.filter(f => f.mimeType !== FOLDER)
      const remoteDirs  = remote.filter(f => f.mimeType === FOLDER)
      let localFiles = 0, localDirs = 0
      try {
        const entries = await readdir(join(REPO, m, 'docs'), { withFileTypes: true })
        localFiles = entries.filter(e =>
          e.isFile() && e.name !== '.DS_Store' && e.name !== '.gitkeep').length
        localDirs = entries.filter(e => e.isDirectory() && e.name !== 'assets').length
      } catch {}
      // 'assets' is uploaded to the shared pool, not into the module's docs/
      const expectDirs = localDirs
      remoteFiles.length === localFiles && remoteDirs.length === expectDirs
        ? ok(`docs folder   ${remoteFiles.length} files` +
             (expectDirs ? `, ${expectDirs} subfolder(s)` : ''))
        : bad(`docs folder   ${remoteFiles.length} files / ${remoteDirs.length} dirs in Drive, ` +
              `${localFiles} / ${expectDirs} on disk`)

      // nothing should carry a path separator in its Drive name
      const slashed = remote.filter(f => f.name.includes('/'))
      if (slashed.length) bad(`docs folder   ${slashed.length} name(s) contain a slash`)
    }

    // every assets/ reference a document makes is resolvable
    const map = ms.assets ?? {}
    if (Object.keys(map).length) {
      let refs = 0, unresolved = 0
      try {
        const names = await readdir(join(REPO, m, 'docs'))
        for (const fn of names.filter(n => /\.html?$/i.test(n))) {
          const raw = await readFile(join(REPO, m, 'docs', fn), 'utf8')
          for (const mt of raw.matchAll(/(["'(])(?:\.\/)?(assets\/[A-Za-z0-9._\-/]+)(["')])/g)) {
            refs++
            if (!map[mt[2]]) unresolved++
          }
        }
      } catch {}
      unresolved ? bad(`assets map    ${unresolved}/${refs} references unresolved`)
                 : ok(`assets map    ${refs} references, all resolvable`)
    }
  }

  // ── write round-trip ───────────────────────────────────────────────────────
  if (DO_WRITE) {
    console.log('\n  write round-trip')
    const m = modules[0]
    const id = state.modules?.[m]?.data?.['notes.json']
    if (!id) meh('no notes.json to test against')
    else {
      try {
        const before = await getJson(drive, id)
        const probe  = { ...before, __verify__: new Date().toISOString() }
        await withRetry('probe write', () => drive.files.update({
          fileId: id, media: { mimeType: 'application/json', body: JSON.stringify(probe) },
        }))
        const after = await getJson(drive, id)
        if (!after.__verify__) throw new Error('write did not take effect')
        // restore
        await withRetry('restore', () => drive.files.update({
          fileId: id, media: { mimeType: 'application/json', body: JSON.stringify(before) },
        }))
        ok(`${m}/notes.json written and restored`)
      } catch (e) { bad(`write failed: ${e.message}`) }
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped\n`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('\n  verify failed:', e.message, '\n'); process.exit(1) })
