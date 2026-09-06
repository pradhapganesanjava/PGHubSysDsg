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
import { readModuleJson, writeModuleJson, moduleFolderId, ensureFolder, createFile }
  from './drive.js'
import { ready } from './ready.js'

const nativeFetch = window.fetch.bind(window)

const FILE_OF = {
  terms:  'terms.json',
  qa:     'qa.json',
  topics: 'topics.json',
  notes:  'notes.json',
}
const UNTAGGED   = 'Untagged'
const FLUSH_MS   = 900
const DOC_EXT_RE = /\.(md|markdown|pdf|html?|)$/i

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
      const data = Store._cache.get(kind) ?? {}
      try {
        await writeModuleJson(Store.mod, FILE_OF[kind] ?? `${kind}.json`, data)
        Store._dirty.delete(kind)
        emit('sysdsg:saved', { kind, pending: Store._dirty.size })
      } catch (e) {
        // Keep it dirty and stop: a later edit, or the page-hide flush, retries.
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

async function docsIndex() {
  if (Store._docs) return Store._docs
  const idx = await readModuleJson(Store.mod, 'docs-index.json', [])
  Store._assets = await readModuleJson(Store.mod, 'assets-map.json', {})
  const tags = await readModuleJson(Store.mod, 'docs.json', {})

  // Tags are edited live, so they are applied from docs.json at read time
  // rather than trusted from the baked index.
  Store._docs = (Array.isArray(idx) ? idx : []).map(d => {
    const meta = tags[d.name] ?? {}
    return {
      ...d,
      tag:  (meta.tag ?? d.tag ?? '').trim() || UNTAGGED,
      tags: Array.isArray(meta.tags) ? meta.tags : (d.tags ?? []),
      // Resolved to a blob: URL by media.js when the doc is actually opened —
      // pre-fetching 677 documents would be absurd.
      url:  d.driveId ? `drive:${d.driveId}` : '',
    }
  })
  return Store._docs
}

export function assetMap() { return Store._assets ?? {} }
export function docNames() { return new Set((Store._docs ?? []).map(d => d.name)) }

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
  Store._cache.set('doctags', clean)
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
  if (item._delete) delete map[id]
  else map[id] = item
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
    const req  = input instanceof Request ? input : new Request(input, init)
    const url  = new URL(req.url, location.href)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const same = url.origin === location.origin

    // Only same-origin app endpoints are ours; everything else is untouched.
    if (!same) return nativeFetch(input, init)

    const key = path.startsWith('/') ? path.slice(1) : path
    const method = req.method.toUpperCase()

    const OURS = new Set(['terms', 'qa', 'topics', 'notes', 'docs', 'doctags', 'upload'])
    if (!OURS.has(key)) return nativeFetch(input, init)

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
          notes[id] = p.html ?? ''
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
