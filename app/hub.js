/* Data layer for the landing page.
 *
 * serve_hub.py answered three things the page still asks for. Their shapes are
 * preserved exactly so index.html's rendering code needs no changes:
 *
 *   hub.json           the manifest — categories, module titles, taglines
 *   /__index__.json    every module's term/QA/topic list, for the tree + search
 *   /__item__.json     one full entry, for the preview pane
 *
 * The first two are single files in Drive (the index is baked at migration
 * time). The third is served out of whichever module's data file it names,
 * cached after the first hit so browsing a module's items is instant.
 */
import { readRootJson, readModuleJson } from './drive.js'
import { ready } from './ready.js'

// The page's shim stashed the real fetch before replacing window.fetch.
// Binding window.fetch here would capture the shim instead and make
// passthrough recurse into this handler until the stack blows.
const nativeFetch = window.__sysdsgNativeFetch ?? window.fetch.bind(window)

const FILE_OF = { terms: 'terms.json', qa: 'qa.json', topics: 'topics.json' }

let _hub = null
let _index = null
const _modData = new Map()      // `${mod}:${type}` -> object

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })

export async function hubManifest() {
  return _hub ??= await readRootJson('hub.json', { modules: {}, categories: [] })
}

async function hubIndex() {
  if (_index) return _index
  _index = await readRootJson('hub-index.json', null)
  if (_index) return _index
  // No baked index (migration not re-run): assemble one from the module files.
  // Slower, but the page works rather than showing an empty tree.
  const hub = await hubManifest()
  const mods = await Promise.all(Object.entries(hub.modules ?? {}).map(async ([dir, m]) => {
    const [terms, qa, topics] = await Promise.all(
      ['terms', 'qa', 'topics'].map(t => modData(dir, t)))
    // Sorted by (group, label) to match what serve_hub.py's build_index
    // emitted, so the tree reads the same whichever path produced it.
    const list = (obj, ...keys) => Object.entries(obj)
      .flatMap(([k, v]) => v && typeof v === 'object'
        ? [{ id: v.id ?? k, label: label(v, keys), group: v.group ?? '' }] : [])
      .sort((a, b) => a.group.toLowerCase().localeCompare(b.group.toLowerCase())
                   || a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
    return {
      dir, title: m.title ?? dir, emoji: m.emoji ?? '',
      terms:  list(terms, 'title'),
      qa:     list(qa, 'question', 'title'),
      topics: list(topics, 'title', 'summary'),
    }
  }))
  return _index = { modules: mods }
}

function label(entry, keys) {
  for (const k of keys) {
    const v = entry[k]
    if (typeof v === 'string' && v.trim()) {
      const t = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (t) return t
    }
  }
  return entry.id ?? ''
}

async function modData(mod, type) {
  const k = `${mod}:${type}`
  if (_modData.has(k)) return _modData.get(k)
  const d = await readModuleJson(mod, FILE_OF[type], {})
  _modData.set(k, d)
  return d
}

async function item(mod, type, id) {
  if (!mod || !(type in FILE_OF) || !id) return null
  const hub = await hubManifest()
  const m = hub.modules?.[mod]
  if (!m) return null
  const entry = (await modData(mod, type))[id]
  if (!entry || typeof entry !== 'object') return null
  return {
    module: { dir: mod, title: m.title ?? mod, emoji: m.emoji ?? '' },
    type, entry,
  }
}

export function installHubStore() {
  const handler = async (input, init = {}) => {
    const req  = input instanceof Request ? input : new Request(input, init)
    const url  = new URL(req.url, location.href)
    if (url.origin !== location.origin) return nativeFetch(input, init)

    const path = url.pathname.replace(/^.*\//, '')     // basename, subpath-safe
    const isOurs = path === 'hub.json' || path === '__index__.json' || path === '__item__.json'
    if (!isOurs) return nativeFetch(input, init)

    await ready
    try {
      if (path === 'hub.json')       return json(await hubManifest())
      if (path === '__index__.json') return json(await hubIndex())
      const got = await item(url.searchParams.get('m'),
                            url.searchParams.get('t'),
                            url.searchParams.get('id'))
      return json(got, got ? 200 : 404)
    } catch (e) {
      return json({ error: e.message }, 500)
    }
  }

  if (typeof window.__sysdsgInstall === 'function') window.__sysdsgInstall(handler)
  else window.fetch = handler
}
