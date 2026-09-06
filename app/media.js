/* Renders Drive-hosted bytes inside a page that expects ordinary URLs.
 *
 * Two things in the app reference files by URL rather than by fetch(): the
 * <iframe> that displays an HTML or PDF document, and the <img> tags inside
 * saved notes. Both now carry a "drive:<fileId>" URL, which a browser cannot
 * load on its own — Drive needs an Authorization header. This module watches
 * the DOM and swaps those for blob: URLs, which browsers treat as ordinary
 * same-origin content.
 *
 * HTML documents get one extra step. They were authored alongside an assets/
 * folder and still reference it relatively ("assets/hi/x.svg"), but a blob:
 * URL has no directory to resolve against, so every one of those links would
 * break. Before building the blob we rewrite each relative asset reference to
 * the blob: URL of that asset in Drive, using the assets-map.json produced
 * during migration.
 */
import { readBlobById } from './drive.js'
import { assetMap }     from './store.js'

const blobs = new Map()        // driveId | 'html:'+driveId -> blob: URL
const inFlight = new Map()
// The reverse direction, and the reason it exists: the note editor saves
// whatever is in the DOM (serialize() returns innerHTML), and by then this
// module has rewritten every <img src="drive:…"> to a blob: URL. Persisting
// those would store a reference that dies with the page. The store consults
// this map on save to put the drive: URL back. See restoreDriveUrls.
const blobToDrive = new Map()

/** Drive id -> blob: URL, fetched once and reused. */
export async function driveBlobUrl(id) {
  if (blobs.has(id)) return blobs.get(id)
  if (inFlight.has(id)) return inFlight.get(id)
  const p = (async () => {
    const blob = await readBlobById(id)
    const url  = URL.createObjectURL(blob)
    blobs.set(id, url)
    blobToDrive.set(url, `drive:${id}`)
    return url
  })().finally(() => inFlight.delete(id))
  inFlight.set(id, p)
  return p
}

const ASSET_REF = /(["'(])(?:\.\/)?(assets\/[A-Za-z0-9._\-/]+)(["')])/g

/**
 * Fetch an HTML document and return a blob: URL for a self-contained copy,
 * with its relative asset references pointed at Drive.
 */
async function htmlDocUrl(id, blob) {
  const key = 'html:' + id
  if (blobs.has(key)) return blobs.get(key)

  // The caller already downloaded the document to sniff its type; reuse it
  // rather than fetching the same (sometimes large) file a second time.
  const raw  = await (blob ?? await readBlobById(id)).text()
  const map  = assetMap()

  // Resolve only the assets this document actually mentions.
  const wanted = new Set()
  for (const m of raw.matchAll(ASSET_REF)) if (map[m[2]]) wanted.add(m[2])
  const resolved = new Map()
  await Promise.all([...wanted].map(async rel => {
    try { resolved.set(rel, await driveBlobUrl(map[rel])) } catch { /* leave broken */ }
  }))

  const html = raw.replace(ASSET_REF, (whole, open, rel, close) =>
    resolved.has(rel) ? `${open}${resolved.get(rel)}${close}` : whole)

  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  blobs.set(key, url)
  blobToDrive.set(url, `drive:${id}`)
  return url
}

// Deliberately plain and theme-neutral: it flashes briefly inside a frame
// whose own stylesheet has not loaded yet.
const LOADING_HTML =
  '<!doctype html><meta charset="utf-8">' +
  '<style>html,body{height:100%;margin:0}' +
  'body{display:flex;align-items:center;justify-content:center;' +
  'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#8b93a1;' +
  'background:#fff}' +
  '@media(prefers-color-scheme:dark){body{background:#161922;color:#8b93a1}}' +
  '</style><div>Loading from Drive…</div>'

/** Swap the placeholder for the real document. srcdoc must go first: while it
 *  is present the browser ignores src entirely. */
function showFrame(el, url) {
  el.removeAttribute('srcdoc')
  el.setAttribute('src', url)
}

async function resolveElement(el) {
  const src = el.getAttribute('src') || ''
  if (!src.startsWith('drive:')) return
  const id = src.slice('drive:'.length)
  if (!id) return
  // The observer sees both the added node and the src attribute, so the same
  // element can arrive twice; without this the document is downloaded twice.
  if (el.dataset.driveResolving === id) return
  el.dataset.driveResolving = id
  el.dataset.driveId = id
  try {
    if (el.tagName !== 'IFRAME') {
      el.setAttribute('src', await driveBlobUrl(id))
      return
    }
    // An HTML document needs its relative assets rewritten before it can load
    // from a blob: URL; anything else (PDF, PNG) is handed over as-is.
    const cached = blobs.get('html:' + id) ?? blobs.get(id)
    if (cached) { showFrame(el, cached); return }

    // Downloading a document and its assets takes a beat, and an iframe whose
    // src it cannot load renders as a blank white box — indistinguishable from
    // a broken page. srcdoc takes precedence over src, so a placeholder can be
    // shown in place without touching the surrounding layout.
    el.srcdoc = LOADING_HTML

    const blob = await readBlobById(id)
    let url
    if (blob.type.includes('html')) {
      url = await htmlDocUrl(id, blob)
    } else {
      url = URL.createObjectURL(blob)
      blobs.set(id, url)
      blobToDrive.set(url, `drive:${id}`)
    }
    showFrame(el, url)
  } catch (e) {
    delete el.dataset.driveResolving          // let a later attempt retry
    // A failed <img> shows its alt text, but a failed <iframe> just sits there
    // blank, which is indistinguishable from a slow load and impossible to
    // diagnose. Say what happened, in the frame's place.
    console.warn(`[sysdsg] could not load drive:${id} —`, e)
    if (el.tagName === 'IMG') {
      el.alt = `[unavailable: ${e.message}]`
    } else {
      el.removeAttribute('srcdoc')
      const note = document.createElement('div')
      note.className = 'sysdsg-doc-error'
      note.style.cssText = 'padding:1.25rem;color:var(--muted,#9aa3b2);' +
                           'font:14px/1.6 system-ui,sans-serif'
      note.textContent = `This document could not be loaded from Drive — ${e.message}`
      el.replaceWith(note)
    }
  }
}

function scan(root) {
  if (!root || root.nodeType !== 1) return
  if (root.matches?.('img[src^="drive:"], iframe[src^="drive:"]')) resolveElement(root)
  root.querySelectorAll?.('img[src^="drive:"], iframe[src^="drive:"]').forEach(resolveElement)
}

/**
 * Put drive: URLs back wherever this module swapped in a blob: URL.
 * Called by the store on every write, so what is persisted always references
 * Drive rather than a URL that expires with the page.
 */
export function restoreDriveUrls(value) {
  if (typeof value === 'string') {
    if (!value.includes('blob:')) return value
    let out = value
    for (const [blobUrl, driveUrl] of blobToDrive) {
      if (out.includes(blobUrl)) out = out.replaceAll(blobUrl, driveUrl)
    }
    return out
  }
  if (Array.isArray(value)) return value.map(restoreDriveUrls)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k in value) out[k] = restoreDriveUrls(value[k])
    return out
  }
  return value
}

/* Test hook: lets the store's test suite register a mapping without a DOM or a
   real Drive round trip. Harmless in production — nothing calls it there. */
export function __test_register(blobUrl, driveUrl) { blobToDrive.set(blobUrl, driveUrl) }

export function installMedia() {
  scan(document.body)
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') { scan(m.target); continue }
      m.addedNodes.forEach(scan)
    }
  }).observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['src'],
  })
  window.addEventListener('pagehide', () => {
    for (const u of blobs.values()) { try { URL.revokeObjectURL(u) } catch {} }
    blobs.clear()
  })
}
