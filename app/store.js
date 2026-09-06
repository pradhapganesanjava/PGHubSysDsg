/* The data layer — a drop-in replacement for the old local server.py.
 *
 * The module apps talk to their backend through exactly fourteen fetch() calls
 * against relative paths (/terms, /qa, /topics, /notes, /docs, /doctags,
 * /upload). Rather than edit 3,000 lines of working application code, this
 * module patches window.fetch and answers those paths itself, out of Google
 * Drive. Anything else — Drive's own API, CDN scripts, GitHub link previews —
 * passes straight through untouched.
 *
 * Two behaviours differ from the old server, both deliberate:
 *
 *   Reads are cached. A module's terms/qa/topics/notes JSON is fetched from
 *   Drive once per session and served from memory afterwards, because a Drive
 *   round trip is ~200ms where a localhost one was ~1ms.
 *
 *   Writes are debounced. The app POSTs once per edited item and the whole
 *   file is rewritten each save, so saving on every keystroke would mean
 *   uploading a 100KB file dozens of times a minute. Edits land in the cache
 *   immediately (so the UI is never wrong) and are flushed to Drive shortly
 *   after the typing stops, plus unconditionally when the page is hidden or
 *   closed. Callers see the same {ok:true} they always did.
 */
import { readModuleJson, writeModuleJson, moduleFolderId, ensureFolder, createFile,
         findChild, listFolder, readTextById } from './drive.js'
import { ready } from './ready.js'
import { restoreDriveUrls } from './media.js'

const nativeFetch = window.fetch.bind(window)

const FILE_OF = {
  terms:  'terms.json',
  qa:     'qa.json',
  topics: 'topics.json',
  notes:  'notes.json',
}
const UNTAGGED = 'Untagged'
const FLUSH_MS = 900

// The endpoints this module owns. Matched on the last path segment so the app
// works unchanged under a GitHub Pages subpath.
const OURS = new Set(['terms', 'qa', 'topics', 'notes', 'docs', 'doctags', 'upload'])

export const Store = {
  mod: null,
  _cache: new Map(),        // 'terms' -> object
  _dirty: new Set(),        // kinds awaiting upload
  _timer: null,
  _inFlight: null,
  _docs: null,              // baked docs-index.json
  _assets: null,            // "assets/hi/x.svg" -> Drive id

  get pendingSaves() { return this._dirty.size },
}

const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

// ── cache ────────────────────────────────────────────────────────────────────

async function load(kind) {
  if (Store._cache.has(kind)) return Store._cache.get(kind)
  const data = await readModuleJson(Store.mod, FILE_OF[kind], {})
  Store._cache.set(kind, data && typeof data === 'object' ? data : {})
  return Store._cache.get(kind)
}

function markDirty(kind) {
  Store._dirty.add(kind)
  emit('sysdsg:dirty', { pending: Store._dirty.size })
  clearTimeout(Store._timer)
  Store._timer = setTimeout(() => { flush() }, FLUSH_MS)
}

/** Upload every dirty file. Serialised so two flushes can't race on one file. */
export async function flush() {
  if (Store._inFlight) return Store._inFlight
  if (!Store._dirty.size) return
  clearTimeout(Store._timer)

  Store._inFlight = (async () => {
    while (Store._dirty.size) {
      const kind = [...Store._dirty][0]
      // Clear the flag BEFORE uploading, not after. An edit that lands while
      // the upload is in flight re-adds it and the loop takes another pass;
      // clearing afterwards would erase that flag and strand the edit in the
      // cache, saved nowhere.
      Store._dirty.delete(kind)
      try {
        await writeModuleJson(Store.mod, FILE_OF[kind] ?? `${kind}.json`,
                              Store._cache.get(kind) ?? {})
        emit('sysdsg:saved', { kind, pending: Store._dirty.size })
      } catch (e) {
        // Put it back and stop; a later edit or the page-hide flush retries.
        Store._dirty.add(kind)
        emit('sysdsg:error', { kind, message: e.message })
        break
      }
    }
  })().finally(() => { Store._inFlight = null })

  return Store._inFlight
}

// Never lose an edit to a closed tab. visibilitychange is the reliable one on
// mobile; pagehide covers desktop navigation.
for (const ev of ['pagehide', 'visibilitychange']) {
  window.addEventListener(ev, () => {
    if (document.visibilityState === 'hidden' || ev === 'pagehide') flush()
  })
}
window.addEventListener('beforeunload', e => {
  if (Store._dirty.size) { e.preventDefault(); e.returnValue = '' }
})

// ── documents ────────────────────────────────────────────────────────────────

const DOC_EXT = /\.(md|markdown|pdf|html?)$/i
const typeOf = name =>
  /\.(md|markdown)$/i.test(name) ? 'markdown' : /\.pdf$/i.test(name) ? 'pdf' : 'html'

/**
 * Documents added to the Drive folder directly, which the baked index cannot
 * know about.
 *
 * Adding a document used to mean dropping a file into the module's docs/
 * folder. That still works — the folder just lives in Drive now — so the
 * listing is reconciled against the index and anything new is folded in.
 * A new markdown file is read so it can render; a new HTML or PDF is not,
 * since it displays in an iframe from its Drive id alone.
 *
 * The one thing a new document lacks is `text`, the extracted search index,
 * which build-docs-index.py produces. It becomes searchable after the next
 * migration; until then it is browsable and readable, which beats invisible.
 */
async function discoverNewDocs(known) {
  try {
    const folder = await moduleFolderId(Store.mod)
    const docsId = await findChild(folder, 'docs')
    if (!docsId) return []
    const files = await listFolder(docsId)
    const added = files.filter(f =>
      f.mimeType !== 'application/vnd.google-apps.folder' &&
      DOC_EXT.test(f.name) && !known.has(f.name))
    return Promise.all(added.map(async f => {
      const type = typeOf(f.name)
      const base = f.name.replace(DOC_EXT, '')
      const doc  = { name: f.name, title: base, type, driveId: f.id,
                     markdown: '', text: '', tag: '', tags: [] }
      if (type === 'markdown') {
        try {
          const md = await readTextById(f.id)
          doc.markdown = md
          doc.text = md
          const h = md.split('\n').find(l => /^\s*#\s+\S/.test(l))
          if (h) doc.title = h.replace(/^\s*#\s+/, '').trim()
        } catch { /* leave it titled by filename */ }
      }
      return doc
    }))
  } catch { return [] }
}

async function docsIndex() {
  if (Store._docs) return Store._docs
  const idx = await readModuleJson(Store.mod, 'docs-index.json', [])
  Store._assets = await readModuleJson(Store.mod, 'assets-map.json', {})
  const tags = await readModuleJson(Store.mod, 'docs.json', {})

  const baked = Array.isArray(idx) ? idx : []
  const all = baked.concat(await discoverNewDocs(new Set(baked.map(d => d.name))))

  // Tags are edited live, so they are applied from docs.json at read time
  // rather than trusted from the baked index.
  Store._docs = all.map(d => {
    const meta = tags[d.name] ?? {}
    return {
      ...d,
      tag:  (meta.tag ?? d.tag ?? '').trim() || UNTAGGED,
      tags: Array.isArray(meta.tags) ? meta.tags : (d.tags ?? []),
      // Resolved to a blob: URL by media.js when the doc is actually opened —
      // pre-fetching 677 documents would be absurd.
      url:  d.driveId ? `drive:${d.driveId}` : '',
    }
  // The sidebar shows `title`, so sort by that, as the old server did.
  }).sort((a, b) => (a.title || a.name).toLowerCase()
        .localeCompare((b.title || b.name).toLowerCase()))
  return Store._docs
}

export function assetMap() { return Store._assets ?? {} }

async function handleDocTags(payload) {
  const data  = await readModuleJson(Store.mod, 'docs.json', {})
  const docs  = await docsIndex()
  const names = new Set(docs.map(d => d.name))

  if (payload._rename) {
    const oldTag = String(payload._rename).trim()
    const newTag = String(payload.to ?? '').trim()
    if (!newTag) return json({ error: 'Missing new tag name' }, 400)
    for (const meta of Object.values(data)) {
      const cur = (meta.tag ?? '').trim()
      // renaming a parent carries its children: "A" -> "B" also moves "A::x"
      if (cur === oldTag) meta.tag = newTag
      else if (cur.startsWith(oldTag + '::')) meta.tag = newTag + cur.slice(oldTag.length)
    }
  } else if (payload._deleteTag) {
    const gone = String(payload._deleteTag).trim()
    for (const meta of Object.values(data)) {
      const cur = (meta.tag ?? '').trim()
      if (cur === gone || cur.startsWith(gone + '::')) meta.tag = ''
    }
  } else {
    const fn = String(payload.name ?? '').trim().split('/').pop()
    if (!names.has(fn)) return json({ error: 'No such doc' }, 404)
    let tag = String(payload.tag ?? '').trim()
    if (tag.toLowerCase() === UNTAGGED.toLowerCase()) tag = ''
    const meta = data[fn] ??= {}
    meta.tag = tag
    if (Array.isArray(payload.tags)) {
      meta.tags = payload.tags.map(x => String(x).trim()).filter(Boolean)
    }
    meta.tags ??= []
  }

  // drop entries for docs that no longer exist, as the old server did
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => names.has(k)))

  Store._docs = null                       // re-derive tags on next read
  // Written through rather than marked dirty: tag edits are rare, and a
  // rename touches every entry, so it is worth persisting immediately.
  try {
    await writeModuleJson(Store.mod, 'docs.json', clean)
  } catch (e) {
    return json({ error: e.message }, 500)
  }
  return json({ ok: true, doctags: clean })
}

// ── image upload ─────────────────────────────────────────────────────────────

async function handleUpload(req) {
  const name   = req.headers.get('X-Filename') || `paste-${Date.now()}.png`
  const subdir = req.headers.get('X-Subdir') || ''
  const blob   = await req.blob()

  const modFolder = await moduleFolderId(Store.mod)
  let parent = await ensureFolder(modFolder, 'images')
  if (subdir) parent = await ensureFolder(parent, subdir)

  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
  const id   = await createFile(parent, `${Date.now()}__${safe}`, blob)
  // A drive: URL is stored in the note HTML; media.js swaps it for a blob:
  // URL at render time. Storing the id rather than a signed URL means the
  // reference stays valid forever.
  return json({ url: `drive:${id}` })
}

// ── plumbing ─────────────────────────────────────────────────────────────────

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })

/** Apply one POSTed item to a cached map, mirroring the old server's rules. */
function applyItem(map, item) {
  const id = String(item.id ?? '').trim()
  if (!id) return json({ error: 'Missing id' }, 400)
  delete item._app
  // Any image the media layer resolved is a blob: URL by now; store the
  // durable drive: reference instead.
  if (item._delete) delete map[id]
  else map[id] = restoreDriveUrls(item)
  return json({ ok: true })
}

export function installStore(moduleId) {
  Store.mod = moduleId

  // The page installed a queueing shim before the app's inline script ran
  // (see tools/build-app.py). Hand it the real handler so parked requests
  // replay; fall back to patching fetch directly if the shim isn't present.
  if (typeof window.__sysdsgInstall === 'function') window.__sysdsgInstall(handleRequest)
  else window.fetch = handleRequest

  async function handleRequest(input, init = {}) {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url, location.href)

    // Only same-origin app endpoints are ours; everything else is untouched.
    if (url.origin !== location.origin) return nativeFetch(input, init)

    const key = url.pathname.replace(/\/+$/, '').replace(/^.*\//, '')
    if (!OURS.has(key)) return nativeFetch(input, init)

    const method = req.method.toUpperCase()

    // Hold the app's opening requests until there is a token to spend on them.
    await ready

    try {
      if (method === 'GET') {
        if (key in FILE_OF) return json(await load(key))
        if (key === 'docs')    return json(await docsIndex())
        if (key === 'doctags') return json(await readModuleJson(Store.mod, 'docs.json', {}))
      }

      if (method === 'POST') {
        if (key === 'notes') {
          const p  = await req.json()
          const id = String(p.id ?? '').trim()
          if (!id) return json({ error: 'Missing id' }, 400)
          const notes = await load('notes')
          notes[id] = restoreDriveUrls(p.html ?? '')
          markDirty('notes')
          return json({ ok: true })
        }
        if (key === 'terms' || key === 'qa' || key === 'topics') {
          const item = await req.json()
          const map  = await load(key)
          const res  = applyItem(map, item)
          if (res.status === 200) markDirty(key)
          return res
        }
        if (key === 'doctags') return await handleDocTags(await req.json())
        if (key === 'upload')  return await handleUpload(req)
      }
    } catch (e) {
      emit('sysdsg:error', { message: e.message })
      return json({ error: e.message }, 500)
    }

    return nativeFetch(input, init)
  }
}
