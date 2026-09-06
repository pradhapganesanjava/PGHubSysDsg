/* Sign-in gate and save indicator — the only UI this layer adds.
 *
 * Everything the hub knows lives in one person's Drive, so the page is useless
 * until a token exists. This renders a full-screen sign-in panel over the app,
 * removes it once Drive is reachable, and puts it back if the session expires.
 * It also shows a small status chip, because writes are debounced and a user
 * who closes a tab deserves to know whether their edit has landed.
 */
import { GAuth, loadGIS } from './gauth.js'
import { markReady } from './ready.js'
import { rootId }    from './drive.js'

const CSS = `
.sysdsg-gate{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;
  justify-content:center;background:#0f1115;color:#e6e8ee;
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.sysdsg-gate__card{max-width:27rem;padding:2.25rem 2.5rem;text-align:center}
.sysdsg-gate__mark{font-size:2.75rem;line-height:1;margin-bottom:.9rem}
.sysdsg-gate h1{margin:0 0 .5rem;font-size:1.3rem;font-weight:650;letter-spacing:-.01em}
.sysdsg-gate p{margin:0 0 1.5rem;color:#9aa3b2;font-size:.9rem}
.sysdsg-gate button{background:#3b82f6;color:#fff;border:0;border-radius:.5rem;
  padding:.7rem 1.4rem;font-size:.92rem;font-weight:560;cursor:pointer}
.sysdsg-gate button:hover{background:#2f6fe0}
.sysdsg-gate button[disabled]{opacity:.55;cursor:progress}
.sysdsg-gate__err{margin-top:1.1rem;color:#f2a0a0;font-size:.83rem;
  white-space:pre-wrap;text-align:left}
.sysdsg-chip{position:fixed;right:.85rem;bottom:.85rem;z-index:2147482000;
  padding:.3rem .7rem;border-radius:999px;font:500 12px/1.4 -apple-system,
  BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:none;
  background:#1b1f27;color:#9aa3b2;border:1px solid #2a3039;
  opacity:0;transition:opacity .18s}
.sysdsg-chip[data-show="1"]{opacity:1}
.sysdsg-chip[data-state="saving"]{color:#e8c37a}
.sysdsg-chip[data-state="error"]{color:#f2a0a0;border-color:#5a2b2b}
@media(prefers-color-scheme:light){
  .sysdsg-gate{background:#f7f8fa;color:#15181e}
  .sysdsg-gate p{color:#5b6472}
  .sysdsg-chip{background:#fff;color:#5b6472;border-color:#dfe3e9}
}`

function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

/**
 * @param onFlush  Optional "save now" callback. The module page passes the
 *                 store's flush; the landing page is read-only and passes
 *                 nothing, which also keeps the store out of its bundle.
 */
export function installGate({ title = 'System Design Hub', emoji = '🧭', onFlush = null } = {}) {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }))

  // Start fetching Google Identity Services now so the sign-in click can open
  // its popup synchronously; see loadGIS.
  loadGIS().catch(() => { /* surfaced on the first click instead */ })

  const gate = el(`
    <div class="sysdsg-gate" role="dialog" aria-modal="true">
      <div class="sysdsg-gate__card">
        <div class="sysdsg-gate__mark">${emoji}</div>
        <h1>${title}</h1>
        <p>This hub reads its content from a private Google Drive folder.
           Sign in with the account that owns it.</p>
        <button type="button">Sign in with Google</button>
        <div class="sysdsg-gate__err" hidden></div>
      </div>
    </div>`)
  const btn = gate.querySelector('button')
  const err = gate.querySelector('.sysdsg-gate__err')
  document.body.appendChild(gate)

  const chip = el('<div class="sysdsg-chip" data-state="idle"></div>')
  document.body.appendChild(chip)

  const fail = e => {
    err.hidden = false
    err.textContent = e.message ?? String(e)
    btn.disabled = false
    btn.textContent = 'Try again'
  }

  async function enter() {
    btn.disabled = true
    btn.textContent = 'Signing in…'
    err.hidden = true
    try {
      if (!GAuth.isSignedIn()) await GAuth.signIn()
      await rootId()                      // fail loudly now, not on first render
      gate.remove()
      markReady()
    } catch (e) { fail(e) }
  }

  btn.addEventListener('click', enter)

  // A token kept from earlier this session skips the click entirely.
  if (GAuth.restore()) enter()

  window.addEventListener('gauth:expired', () => {
    if (!document.body.contains(gate)) {
      document.body.appendChild(gate)
      btn.disabled = false
      btn.textContent = 'Sign in with Google'
      err.hidden = false
      err.textContent = 'Your session expired. Sign in again to keep working — ' +
                        'nothing you changed has been lost.'
    }
  })

  // ── save indicator ─────────────────────────────────────────────────────────
  let hideTimer
  const show = (state, text, sticky = false) => {
    chip.dataset.state = state
    chip.dataset.show = '1'
    chip.textContent = text
    clearTimeout(hideTimer)
    if (!sticky) hideTimer = setTimeout(() => { chip.dataset.show = '0' }, 1600)
  }
  window.addEventListener('sysdsg:dirty', e =>
    show('saving', `Saving${e.detail.pending > 1 ? ` (${e.detail.pending})` : ''}…`, true))
  window.addEventListener('sysdsg:saved', e => {
    if (e.detail.pending === 0) show('idle', 'Saved to Drive')
  })
  window.addEventListener('sysdsg:error', e =>
    show('error', `Save failed — ${e.detail.message}`, true))

  // Manual save is worth exposing; the app has no other "save now".
  if (onFlush) {
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); onFlush() }
    })
  }
}
