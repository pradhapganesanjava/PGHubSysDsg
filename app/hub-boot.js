/* Entry point for the landing page (index.html).
 *
 * Lighter than the module boot: the hub only reads — the manifest, the baked
 * cross-module index, and single entries for the preview pane — so it needs
 * no store, no media rewriting and no save indicator. Just a session and the
 * three endpoints serve_hub.py used to answer.
 */
import { mountThemePicker } from './theme-picker.js'
import * as Settings from './settings.js'
import { installHubStore } from './hub.js'
import { installGate }     from './gate.js'
import * as Search         from './search.js'
import { ready }           from './ready.js'

installHubStore()
installGate({ title: 'System Design Hub', emoji: '🧭' })

// The landing page's inline script owns the Browse pane, so the search module
// is handed to it rather than reaching into the DOM from here.
window.__sysdsgSearch = Search

// Warm the index once there is a session, so the first search is instant. It
// is ~0.9 MB gzipped, fetched in the background; a search issued before it
// lands simply waits on the same promise.
ready.then(() => Search.loadIndex().catch(() => { /* surfaced on first search */ }))

// ── shared preferences ──────────────────────────────────────────────────────
// The page's own applyTheme is a plain function in its inline script, so it is
// on window; settings calls back into it when another page or Drive changes
// the theme. withRemote stops that arriving change bouncing straight back out.
window.__sysdsgSettings = Settings
Settings.onThemeChange(t => Settings.withRemote(() => window.applyTheme?.(t)))
Settings.syncFromDrive().catch(() => { /* the local theme stands */ })
mountThemePicker(document.getElementById('themeSwatches'))
