/* Preferences shared by the hub and every module, and across devices.
 *
 * The theme was already shared between pages on this origin by a cookie, which
 * is what lets a page paint correctly before anything has loaded — no flash of
 * the wrong theme, and no need to be signed in. That stays the fast path.
 *
 * Two things it did not do, which this adds:
 *
 *   Pages already open went stale. A cookie is read once; a hub sitting open
 *   beside a module never noticed the module change the theme. Changes are now
 *   broadcast to every open page on the origin.
 *
 *   Nothing followed you to another browser or machine, because a cookie is
 *   per-browser. Settings are mirrored to settings.json in the Drive folder,
 *   read once a session exists.
 *
 * Drive is authoritative only when it is genuinely newer: both sides carry a
 * timestamp and the later one wins, so opening an old tab does not undo a
 * change made somewhere else.
 */
import { readRootJson, writeRootJson } from './drive.js'
import { ready } from './ready.js'

const FILE      = 'settings.json'
const COOKIE    = 'sysdsg_theme'
const STAMP_KEY = 'sysdsg_theme_at'
const CHANNEL   = 'sysdsg:settings'
const WRITE_MS  = 1200

const THEMES = ['dark', 'moonlight', 'gray', 'soft', 'white', 'colorful', 'cartoon']
export const isTheme = t => THEMES.includes(t)

// ── local, synchronous, available before sign-in ─────────────────────────────

export function readCookie(k) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}
function writeCookie(k, v) {
  try {
    document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=31536000;SameSite=Lax`
  } catch { /* cookies blocked — the tab still themes itself, just not the next one */ }
}

export function localTheme() {
  const t = readCookie(COOKIE)
  return isTheme(t) ? t : null
}
function localStamp() { return Number(readCookie(STAMP_KEY)) || 0 }

// ── live propagation between open pages ──────────────────────────────────────

const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null
const listeners = new Set()

/** Called with a theme id whenever another page (or Drive) changes it. */
export function onThemeChange(fn) { listeners.add(fn) }
function announce(theme) { for (const fn of listeners) { try { fn(theme) } catch {} } }

if (bc) {
  bc.onmessage = e => {
    const t = e.data?.theme
    if (isTheme(t) && t !== document.documentElement.getAttribute('data-theme')) announce(t)
  }
}
// Fallback for browsers without BroadcastChannel, and a second path in every
// browser: localStorage fires `storage` in other documents of this origin.
window.addEventListener('storage', e => {
  if (e.key !== CHANNEL) return
  const t = e.newValue
  if (isTheme(t) && t !== document.documentElement.getAttribute('data-theme')) announce(t)
})

// ── Drive mirror ─────────────────────────────────────────────────────────────

let pending = null
let queued  = null

function flushToDrive() {
  if (!queued) return Promise.resolve()
  const payload = queued
  queued = null
  return writeRootJson(FILE, payload).catch(() => { /* local copy still stands */ })
}

let applying = false

/**
 * Apply a theme that came from elsewhere without sending it straight back out.
 * The page's own applyTheme calls setTheme unconditionally, so without this a
 * remote change would be re-broadcast to everyone who just sent it.
 */
export function withRemote(fn) {
  applying = true
  try { fn() } finally { applying = false }
}

/** Record a theme choice: locally at once, to Drive shortly after. */
export function setTheme(theme) {
  if (applying || !isTheme(theme)) return
  const at = Date.now()
  writeCookie(COOKIE, theme)
  writeCookie(STAMP_KEY, String(at))

  try { bc?.postMessage({ theme, at }) } catch {}
  // The storage event only fires in OTHER documents, so this is safe to write
  // unconditionally; it is a signal, not state.
  try { localStorage.setItem(CHANNEL, theme); localStorage.removeItem(CHANNEL) } catch {}

  queued = { theme, updatedAt: new Date(at).toISOString() }
  clearTimeout(pending)
  pending = setTimeout(flushToDrive, WRITE_MS)
}

/**
 * Adopt the Drive copy if it is newer than this browser's. Call after sign-in.
 * Returns the theme that should now be showing, or null if nothing changed.
 */
export async function syncFromDrive() {
  await ready
  let remote
  try { remote = await readRootJson(FILE, null) } catch { return null }
  if (!remote || !isTheme(remote.theme)) return null

  const remoteAt = Date.parse(remote.updatedAt ?? '') || 0
  if (remoteAt <= localStamp()) return null          // ours is the same or newer

  writeCookie(COOKIE, remote.theme)
  writeCookie(STAMP_KEY, String(remoteAt))
  if (remote.theme !== document.documentElement.getAttribute('data-theme')) {
    announce(remote.theme)
    return remote.theme
  }
  return null
}

// A queued write must not be lost to a closing tab.
window.addEventListener('pagehide', () => { flushToDrive() })
