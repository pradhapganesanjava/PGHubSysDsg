#!/usr/bin/env node
/**
 * End-to-end check against the real Drive folder.
 *
 * tools/test/run.mjs stubs Drive to test the store's logic. This does the
 * opposite: it runs the REAL app/drive.js and app/store.js — the same code the
 * browser loads — against the real migrated content, so what it proves is that
 * the hub actually works when pointed at Drive.
 *
 * Only two things are substituted, neither of them app logic:
 *   gauth.js  a browser OAuth popup cannot run here, so it is replaced with a
 *             token minted from the saved refresh token. Every Drive request
 *             still goes through the same GAuth.fetch the app calls.
 *   ready.js  resolves immediately instead of waiting on the sign-in gate.
 *
 *   node tools/test/integration.mjs [module]
 */
import { mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir }          from 'node:os'
import { dirname, join }   from 'node:path'
import { fileURLToPath }   from 'node:url'
import { pathToFileURL }   from 'node:url'
import assert              from 'node:assert/strict'
import { authorize }       from '../lib/auth.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const APP   = join(__dir, '..', '..', 'app')
const MOD   = process.argv[2] ?? '01-foundations'

let pass = 0, fail = 0
const ok  = m => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, e) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}\n      ${e}`) }
async function test(name, fn) {
  try { const note = await fn(); ok(note ? `${name} — ${note}` : name) }
  catch (e) { bad(name, e.message) }
}

// ── browser shims ────────────────────────────────────────────────────────────
const store = new Map()
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
globalThis.sessionStorage = globalThis.localStorage
globalThis.location = { href: 'http://localhost/module.html', origin: 'http://localhost' }
globalThis.document = { visibilityState: 'visible' }
globalThis.CustomEvent = class extends Event {
  constructor(t, o = {}) { super(t); this.detail = o.detail }
}
const events = []
globalThis.window = {
  fetch: globalThis.fetch.bind(globalThis),
  addEventListener: () => {},
  dispatchEvent: ev => { events.push(ev.type); return true },
  location: globalThis.location,
}

// ── sandbox: real app code, substituted auth ─────────────────────────────────
const auth = await authorize()
const { token } = await auth.getAccessToken()
if (!token) { console.error('  could not mint an access token'); process.exit(1) }

const dir = await mkdtemp(join(tmpdir(), 'sysdsg-int-'))
await cp(APP, dir, { recursive: true })
await writeFile(join(dir, 'gauth.js'), `
// Node stand-in for the browser OAuth layer. Same surface, real token.
const TOKEN = ${JSON.stringify(token)}
export function loadGIS() { return Promise.resolve() }
export const GAuth = {
  getToken: () => TOKEN,
  getUser:  () => null,
  isSignedIn: () => true,
  restore: () => true,
  signIn: () => Promise.resolve(null),
  signOut() {},
  async withAuthRetry(make) { return make() },
  fetch(url, init = {}) {
    const headers = new Headers(init.headers || {})
    headers.set('Authorization', 'Bearer ' + TOKEN)
    return globalThis.fetch(url, { ...init, headers })
  },
}
`)
await writeFile(join(dir, 'ready.js'),
  'export const ready = Promise.resolve()\nexport function markReady() {}\n')

const u = f => pathToFileURL(join(dir, f)).href
const drive = await import(u('drive.js'))
const { installStore, Store, flush } = await import(u('store.js'))
const hub = await import(u('hub.js'))

console.log(`\n  Live Drive check — module ${MOD}\n`)

// ── drive layer ──────────────────────────────────────────────────────────────
let rootId
await test('resolves the SysDsgHub root folder by name', async () => {
  rootId = await drive.rootId()
  assert.match(rootId, /^[A-Za-z0-9_-]{10,}$/)
  return rootId
})

await test('reads hub.json from Drive', async () => {
  const h = await drive.readRootJson('hub.json', null)
  assert.ok(h?.modules, 'no modules key')
  assert.equal(Object.keys(h.modules).length, 13)
  return `${Object.keys(h.modules).length} modules, tagline "${(h.tagline ?? '').slice(0, 32)}…"`
})

await test('reads the baked cross-module index', async () => {
  const idx = await drive.readRootJson('hub-index.json', null)
  const items = idx.modules.reduce((a, m) => a + m.terms.length + m.qa.length + m.topics.length, 0)
  assert.ok(items > 500, `only ${items} items`)
  return `${idx.modules.length} modules, ${items} items`
})

// ── the store, through the patched fetch ─────────────────────────────────────
installStore(MOD)
const F = window.fetch
const get = p => F(`http://localhost/${p}`)

let termCount = 0
await test('GET /terms serves real content', async () => {
  const terms = await (await get('terms')).json()
  termCount = Object.keys(terms).length
  assert.ok(termCount > 0, 'no terms came back')
  const first = Object.values(terms)[0]
  assert.ok(first.title, 'entry has no title')
  return `${termCount} terms, first "${first.title}"`
})

await test('GET /qa and /topics serve real content', async () => {
  const qa = await (await get('qa')).json()
  const tp = await (await get('topics')).json()
  return `${Object.keys(qa).length} Q&A, ${Object.keys(tp).length} topics`
})

let docs = []
await test('GET /docs returns the document list', async () => {
  docs = await (await get('docs')).json()
  assert.ok(docs.length > 0, 'no documents')
  assert.ok(docs.every(d => d.url.startsWith('drive:') || d.type === 'markdown'),
    'a document has no Drive reference')
  const tagged = docs.filter(d => d.tag && d.tag !== 'Untagged').length
  return `${docs.length} docs, ${tagged} tagged`
})

await test('a document downloads from Drive', async () => {
  const d = docs.find(x => x.type === 'html') ?? docs[0]
  const bytes = await drive.readBlobById(d.driveId)
  assert.ok(bytes.size > 100, `only ${bytes.size} bytes`)
  return `"${d.title.slice(0, 40)}" — ${(bytes.size / 1024).toFixed(0)} KB`
})

await test('a document\'s assets resolve to Drive ids', async () => {
  const map = await drive.readModuleJson(MOD, 'assets-map.json', {})
  const d = docs.find(x => x.type === 'html')
  if (!d) return 'no html docs in this module'
  const raw = await (await drive.readBlobById(d.driveId)).text()
  const refs = [...raw.matchAll(/(["'(])(?:\.\/)?(assets\/[A-Za-z0-9._\-/]+)(["')])/g)]
  const missing = refs.filter(m => !map[m[2]])
  assert.equal(missing.length, 0, `${missing.length} of ${refs.length} unresolved`)
  return `${refs.length} references, all resolvable`
})

// ── write path ───────────────────────────────────────────────────────────────
await test('an edit round-trips through Drive', async () => {
  const probe = `__integration_${Date.now()}`
  const before = JSON.parse(JSON.stringify(await (await get('terms')).json()))

  await F('http://localhost/terms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: probe, title: 'Integration probe', group: 'tmp' }),
  })
  assert.equal(Store.pendingSaves, 1, 'edit was not queued')
  await flush()
  assert.equal(Store.pendingSaves, 0, 'flush left work pending')

  // Re-read straight from Drive, bypassing the store's cache entirely.
  Store._cache.delete('terms')
  const after = await drive.readModuleJson(MOD, 'terms.json', {})
  assert.ok(after[probe], 'the probe never reached Drive')

  // Restore.
  await drive.writeModuleJson(MOD, 'terms.json', before)
  const restored = await drive.readModuleJson(MOD, 'terms.json', {})
  assert.equal(restored[probe], undefined, 'cleanup failed')
  assert.equal(Object.keys(restored).length, termCount, 'restore changed the count')
  return `wrote and removed ${probe}`
})

// ── shared settings ──────────────────────────────────────────────────────────
await test('the settings file round-trips through Drive', async () => {
  const before = await drive.readRootJson('settings.json', null)
  const probe = { theme: 'moonlight', updatedAt: new Date().toISOString(), __probe: true }
  await drive.writeRootJson('settings.json', probe)
  const after = await drive.readRootJson('settings.json', null)
  assert.equal(after?.theme, 'moonlight', 'the theme did not come back')
  assert.equal(after?.__probe, true)
  // Put back whatever was there, or a neutral record if there was nothing.
  await drive.writeRootJson('settings.json',
    before ?? { theme: 'dark', updatedAt: new Date().toISOString() })
  const restored = await drive.readRootJson('settings.json', null)
  assert.equal(restored?.__probe, undefined, 'cleanup left the probe behind')
  return before ? `restored the existing record (${before.theme})` : 'seeded a default record'
})

// ── landing page ─────────────────────────────────────────────────────────────
await test('the landing page manifest loads', async () => {
  const man = await hub.hubManifest()
  assert.ok(man.categories?.length, 'no categories')
  return `${man.categories.length} categories, ${Object.keys(man.modules).length} modules`
})

await rm(dir, { recursive: true, force: true })
console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
