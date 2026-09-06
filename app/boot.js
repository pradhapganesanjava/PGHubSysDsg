/* Entry point for module.html.
 *
 * Wires the Drive-backed store into the page, puts the sign-in gate up, and
 * once a session exists fills in the module's identity from hub.json — which
 * lives in Drive with everything else, so even the module titles and taglines
 * stay out of the public repository.
 */
import { installStore, flush } from './store.js'
import { installMedia }        from './media.js'
import { installGate }         from './gate.js'
import { ready }               from './ready.js'
import { readRootJson } from './drive.js'

const params = new URLSearchParams(location.search)
const mod    = params.get('m') || '01-foundations'

installStore(mod)
installMedia()
installGate({ title: 'System Design Hub', emoji: '🧭', onFlush: flush })

ready.then(async () => {
  try {
    const hub = await readRootJson('hub.json', {})
    const m   = hub.modules?.[mod]
    if (!m) return
    document.title = `${m.title} — SysDsg Hub`
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) el.textContent = v }
    set('#mod-emoji', m.emoji ?? '')
    set('#mod-title', m.title ?? mod)
    set('#mod-sub',   m.sub ?? '')
  } catch { /* identity is cosmetic — the app works without it */ }
})
