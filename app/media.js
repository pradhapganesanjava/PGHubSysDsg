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

const blobs = new Map()     // driveId | 'html:'+driveId -> blob: URL
const inFlight = new Map()

/** Drive id -> blob: URL, fetched once and reused. */
export async function driveBlobUrl(id) {
  if (blobs.has(id)) return blobs.get(id)
  if (inFlight.has(id)) return inFlight.get(id)
  const p = (async () => {
    const blob = await readBlobById(id)
    const url  = URL.createObjectURL(blob)
    blobs.set(id, url)
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
async function htmlDocUrl(id) {
  const key = 'html:' + id
  if (blobs.has(key)) return blobs.get(key)

  const raw  = await (await readBlobById(id)).text()
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
  return url
}

async function resolveElement(el) {
  const src = el.getAttribute('src') || ''
  if (!src.startsWith('drive:')) return
  const id = src.slice('drive:'.length)
  if (!id) return
  el.dataset.driveId = id
  try {
    // An HTML document needs its assets rewritten; anything else (PDF, PNG,
    // SVG) can be handed to the browser as-is.
    const isFrame = el.tagName === 'IFRAME'
    let url
    if (isFrame) {
      const blob = await readBlobById(id)
      url = blob.type.includes('html') ? await htmlDocUrl(id) : URL.createObjectURL(blob)
      if (!blobs.has(id) && !blob.type.includes('html')) blobs.set(id, url)
    } else {
      url = await driveBlobUrl(id)
    }
    el.setAttribute('src', url)
  } catch (e) {
    if (el.tagName === 'IMG') el.alt = `[unavailable: ${e.message}]`
  }
}

function scan(root) {
  if (!root || root.nodeType !== 1) return
  if (root.matches?.('img[src^="drive:"], iframe[src^="drive:"]')) resolveElement(root)
  root.querySelectorAll?.('img[src^="drive:"], iframe[src^="drive:"]').forEach(resolveElement)
}

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
