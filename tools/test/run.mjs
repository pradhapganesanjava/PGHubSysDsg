#!/usr/bin/env node
/* Logic tests for the Drive-backed store.
 *
 * The store is the piece that has to behave exactly like the Python server it
 * replaced, so it is worth testing without a browser in the loop. The app
 * modules are copied to a temp directory where drive.js is swapped for an
 * in-memory stub; nothing in app/ is modified or written for testability.
 */
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir }                     from 'node:os'
import { join }                       from 'node:path'
import { pathToFileURL }              from 'node:url'
import assert                         from 'node:assert/strict'

const APP = new URL('../../app/', import.meta.url)

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`) }
}

// ── environment shims ────────────────────────────────────────────────────────
const listeners = {}
globalThis.window = {
  fetch: async () => new Response('upstream', { status: 200 }),
  addEventListener: (k, f) => (listeners[k] ??= []).push(f),
  dispatchEvent: ev => (listeners[ev.type] ?? []).forEach(f => f(ev)),
  location: { href: 'http://localhost/module.html', origin: 'http://localhost' },
}
// store.js reads the bare global `location`, as browser code does.
globalThis.location = window.location
globalThis.document = { visibilityState: 'visible' }
globalThis.CustomEvent = class extends Event {
  constructor(t, o = {}) { super(t); this.detail = o.detail }
}
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.get(k) ?? null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
  key(i) { return [...this._m.keys()][i] ?? null },
  get length() { return this._m.size },
}

// ── build the sandbox ────────────────────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'sysdsg-test-'))
await cp(APP, dir, { recursive: true })

// In-memory Drive. `writes` counts uploads so debouncing can be asserted.
await writeFile(join(dir, 'drive.js'), `
export const DB = {
  files: {
    'terms.json':  { a: { id: 'a', title: 'Alpha' } },
    'qa.json':     {},
    'topics.json': {},
    'notes.json':  {},
    'docs.json':   { 'x.html': { tag: 'A::sub', tags: ['t'] },
                     'y.html': { tag: 'B',      tags: [] } },
    'docs-index.json': [ { name: 'x.html', title: 'X', type: 'html', driveId: 'D1' },
                         { name: 'y.html', title: 'Y', type: 'html', driveId: 'D2' } ],
    'assets-map.json': { 'assets/a.svg': 'A1' },
  },
  docsFolder: false,
  folderListing: [],
  driveFiles: {},
  writes: 0,
  delay: 0,
}
export async function readModuleJson(mod, name, fallback = {}) {
  const v = DB.files[name]
  return v === undefined ? fallback : JSON.parse(JSON.stringify(v))
}
export async function writeModuleJson(mod, name, data) {
  DB.writes++
  const snapshot = JSON.parse(JSON.stringify(data))
  if (DB.delay) await new Promise(r => setTimeout(r, DB.delay))
  DB.files[name] = snapshot
  return 'id'
}
export async function moduleFolderId() { return 'MOD' }
export async function ensureFolder(p, n) { return p + '/' + n }
export async function createFile(parent, name) { return 'NEW_' + name }
export async function readBlobById() { return new Blob(['x']) }
export async function readJsonById(id, f = {}) { return f }
export async function readTextById(id) { return DB.driveFiles?.[id] ?? '' }
export async function findChild(parent, name) {
  return name === 'docs' && DB.docsFolder ? { id: 'DOCSFOLDER' } : null
}
export async function listFolder() { return DB.folderListing ?? [] }
export async function rootId() { return 'ROOT' }
export function clearIdCache() {}
`)
// The gate normally resolves this after sign-in.
await writeFile(join(dir, 'ready.js'),
  'export const ready = Promise.resolve()\nexport function markReady() {}\n')

const u = f => pathToFileURL(join(dir, f)).href
const { installStore, Store, flush } = await import(u('store.js'))
const { DB } = await import(u('drive.js'))

installStore('01-foundations')
const F = window.fetch
const get  = p => F(`http://localhost${p}`)
const post = (p, body) => F(`http://localhost${p}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })

console.log('\n  store\n')

await test('GET /terms returns the Drive file', async () => {
  assert.deepEqual(await (await get('/terms')).json(), { a: { id: 'a', title: 'Alpha' } })
})

await test('unknown paths pass through untouched', async () => {
  assert.equal(await (await get('/nope')).text(), 'upstream')
})

await test('cross-origin requests pass through untouched', async () => {
  assert.equal(await (await F('https://example.com/x')).text(), 'upstream')
})

await test('POST /terms adds an item and it reads back', async () => {
  await post('/terms', { id: 'b', title: 'Beta' })
  const all = await (await get('/terms')).json()
  assert.equal(all.b.title, 'Beta')
})

await test('POST /terms with _delete removes it', async () => {
  await post('/terms', { id: 'b', _delete: true })
  assert.equal((await (await get('/terms')).json()).b, undefined)
})

await test('POST /terms without an id is rejected', async () => {
  assert.equal((await post('/terms', { title: 'no id' })).status, 400)
})

await test('the _app guard field is never persisted', async () => {
  await post('/terms', { id: 'c', title: 'C', _app: 'other' })
  assert.equal('_app' in (await (await get('/terms')).json()).c, false)
})

await test('writes are debounced, not one upload per POST', async () => {
  DB.writes = 0
  for (let i = 0; i < 10; i++) await post('/terms', { id: 'x' + i, title: 'X' + i })
  assert.equal(DB.writes, 0, 'uploaded before the debounce elapsed')
  await flush()
  assert.equal(DB.writes, 1, `expected 1 upload, saw ${DB.writes}`)
  assert.equal(Object.keys(DB.files['terms.json']).length, 12)
})

await test('notes save under their id', async () => {
  await post('/notes', { id: 'a', html: '<p>hi</p>' })
  await flush()
  assert.equal(DB.files['notes.json'].a, '<p>hi</p>')
})

await test('an edit during an in-flight save is not stranded', async () => {
  // The upload snapshots the data, so an edit that lands mid-flight is not in
  // that snapshot. It must still be marked dirty afterwards, or it would sit
  // in the cache having been saved nowhere.
  DB.files['terms.json'] = {}
  Store._cache.delete('terms')
  await post('/terms', { id: 'first', title: 'First' })

  DB.delay = 60
  const inFlight = flush()                       // begins uploading {first}
  await new Promise(r => setTimeout(r, 20))      // ...land an edit mid-upload
  await post('/terms', { id: 'second', title: 'Second' })
  await inFlight
  DB.delay = 0

  // The flush loop re-reads the dirty set each pass, so the re-added flag is
  // drained before it returns. What matters is that the edit reached Drive:
  // with the flag cleared after the upload instead of before, 'second' would
  // have been dropped here and left sitting in the cache.
  assert.deepEqual(Object.keys(DB.files['terms.json']).sort(), ['first', 'second'])
  assert.equal(Store.pendingSaves, 0)
})

console.log('\n  docs\n')

await test('GET /docs applies live tags and drive: urls', async () => {
  const docs = await (await get('/docs')).json()
  assert.equal(docs.find(d => d.name === 'x.html').tag, 'A::sub')
  assert.equal(docs.find(d => d.name === 'x.html').url, 'drive:D1')
})

await test('an untagged doc reports as Untagged', async () => {
  DB.files['docs.json'] = { 'x.html': { tag: '', tags: [] } }
  Store._docs = null
  const docs = await (await get('/docs')).json()
  assert.equal(docs.find(d => d.name === 'y.html').tag, 'Untagged')
})

await test('setting a tag persists it', async () => {
  DB.files['docs.json'] = { 'x.html': { tag: 'A', tags: [] } }
  Store._docs = null
  await post('/doctags', { name: 'y.html', tag: 'C', tags: ['k'] })
  assert.equal(DB.files['docs.json']['y.html'].tag, 'C')
  assert.deepEqual(DB.files['docs.json']['y.html'].tags, ['k'])
})

await test('tagging an unknown doc 404s', async () => {
  assert.equal((await post('/doctags', { name: 'ghost.html', tag: 'Z' })).status, 404)
})

await test('renaming a tag carries its sub-tags', async () => {
  DB.files['docs.json'] = { 'x.html': { tag: 'A::sub', tags: [] },
                            'y.html': { tag: 'A', tags: [] } }
  Store._docs = null
  await post('/doctags', { _rename: 'A', to: 'B' })
  assert.equal(DB.files['docs.json']['x.html'].tag, 'B::sub')
  assert.equal(DB.files['docs.json']['y.html'].tag, 'B')
})

await test('deleting a tag untags it and its children', async () => {
  DB.files['docs.json'] = { 'x.html': { tag: 'A::sub', tags: [] },
                            'y.html': { tag: 'A', tags: [] } }
  Store._docs = null
  await post('/doctags', { _deleteTag: 'A' })
  assert.equal(DB.files['docs.json']['x.html'].tag, '')
  assert.equal(DB.files['docs.json']['y.html'].tag, '')
})

await test('entries for vanished docs are pruned', async () => {
  DB.files['docs.json'] = { 'x.html': { tag: 'A', tags: [] },
                            'gone.html': { tag: 'Z', tags: [] } }
  Store._docs = null
  await post('/doctags', { name: 'x.html', tag: 'A' })
  assert.equal('gone.html' in DB.files['docs.json'], false)
})

await test('a document added to Drive directly shows up', async () => {
  // Dropping a file into the module's docs/ folder used to be how documents
  // were added; the folder just lives in Drive now.
  DB.docsFolder = true
  DB.folderListing = [
    { id: 'D1', name: 'x.html' },                 // already in the baked index
    { id: 'D9', name: 'brand-new.md' },           // not
    { id: 'D8', name: 'notes.txt' },              // not a document type
  ]
  DB.driveFiles = { D9: '# A Fresh Note\n\nbody text' }
  Store._docs = null
  const docs = await (await get('/docs')).json()

  const fresh = docs.find(d => d.name === 'brand-new.md')
  assert.ok(fresh, 'new markdown file was not discovered')
  assert.equal(fresh.title, 'A Fresh Note', 'title should come from the # heading')
  assert.equal(fresh.type, 'markdown')
  assert.ok(fresh.markdown.includes('body text'), 'content should be loaded so it renders')
  assert.equal(fresh.tag, 'Untagged')
  assert.equal(docs.filter(d => d.name === 'x.html').length, 1, 'indexed doc duplicated')
  assert.equal(docs.find(d => d.name === 'notes.txt'), undefined, 'non-document included')
})

await test('the docs list is sorted by displayed title', async () => {
  const docs = await (await get('/docs')).json()
  const titles = docs.map(d => (d.title || d.name).toLowerCase())
  assert.deepEqual(titles, [...titles].sort(), 'sidebar order would look random')
})

await test('discovery failing does not break the docs list', async () => {
  DB.docsFolder = false
  DB.folderListing = []
  Store._docs = null
  const docs = await (await get('/docs')).json()
  assert.equal(docs.length, 2, 'baked index should still come through')
})

console.log('\n  blob round-trip\n')

await test('a blob: URL is stored back as its drive: reference', async () => {
  // Mirrors what happens in the browser: media.js hands the DOM a blob: URL,
  // the editor serialises innerHTML, and the store must persist drive: again.
  const media = await import(u('media.js'))
  const blobUrl = URL.createObjectURL(new Blob(['x']))
  // Reach into the same map media.js populates when it resolves an image.
  const restored = (() => {
    // simulate resolution by round-tripping through the public helper after
    // registering the mapping the way driveBlobUrl would
    media.__test_register?.(blobUrl, 'drive:IMG1')
    return media.restoreDriveUrls(`<p><img src="${blobUrl}"></p>`)
  })()
  assert.equal(restored, '<p><img src="drive:IMG1"></p>')
})

await test('strings without blob: URLs are returned untouched', async () => {
  const media = await import(u('media.js'))
  const html = '<p><img src="drive:D9"></p>'
  assert.equal(media.restoreDriveUrls(html), html)
})

console.log('\n  upload\n')

await test('an image upload returns a drive: url', async () => {
  const res = await F('http://localhost/upload', {
    method: 'POST',
    headers: { 'X-Filename': 'a b.png', 'X-Subdir': 'terms' },
    body: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  })
  assert.match((await res.json()).url, /^drive:NEW_\d+__a_b\.png$/)
})

await rm(dir, { recursive: true, force: true })
console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
