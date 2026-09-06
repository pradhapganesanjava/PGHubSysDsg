/* Google Identity Services — OAuth token flow for the browser.
 *
 * Ported from the equivalent layer in _PGHubTech, trimmed to what this hub
 * needs. The important behaviour is withAuthRetry: Drive access tokens last an
 * hour, and this app is one people leave open all day, so a save that lands
 * after expiry must not lose the user's writing. Every call goes through
 * GAuth.fetch, which re-authorizes silently and retries once on a 401.
 */
import { Config, LS, isEmailAllowed } from './config.js'

const TOK_KEY = 'tok'
const USR_KEY = 'usr'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
let _gisPromise = null

/** Load Google Identity Services once.
 *
 * Called eagerly at gate install, not lazily inside the click handler: opening
 * the OAuth popup must happen in the same task as the user's click, and an
 * `await` before requestAccessToken spends that user-gesture token, after which
 * Chrome blocks the popup silently — the button just sits on "Signing in…".
 */
export function loadGIS() {
  if (typeof google !== 'undefined' && google.accounts?.oauth2) return Promise.resolve()
  return _gisPromise ??= new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    const s = existing ?? Object.assign(document.createElement('script'),
      { src: GIS_SRC, async: true, defer: true })
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error(
      'Could not load Google sign-in. A network block or tracking-protection ' +
      'extension is the usual cause.')))
    if (!existing) document.head.appendChild(s)
  })
}

export const GAuth = {
  _token: null,
  _user:  null,
  _reauthInFlight: null,

  /** Restore a token saved earlier this session (survives page reloads). */
  restore() {
    try {
      const raw = sessionStorage.getItem(Config.ns + TOK_KEY)
      if (!raw) return false
      const { token, expires } = JSON.parse(raw)
      if (Date.now() >= expires - 5 * 60 * 1000) return false   // <5 min left
      this._token = token
      const u = sessionStorage.getItem(Config.ns + USR_KEY)
      if (u) this._user = JSON.parse(u)
      return true
    } catch { return false }
  },

  getToken() { return this._token },
  getUser()  { return this._user },
  isSignedIn() { return !!this._token },

  signIn() {
    // Fast path: GIS is already loaded (preloaded at gate install), so the
    // token client is built and the popup opened synchronously, still inside
    // the click's gesture. Only a cold start pays the await, and then the
    // user's second click succeeds.
    if (typeof google === 'undefined' || !google.accounts?.oauth2) {
      return loadGIS().then(() => this._requestToken())
    }
    return this._requestToken()
  },

  _requestToken() {
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: Config.clientId,
        scope: Config.scopes.join(' '),
        callback: async res => {
          if (res.error) { reject(new Error(res.error)); return }
          this._token = res.access_token
          const expires = Date.now() + (res.expires_in ?? 3600) * 1000
          try {
            sessionStorage.setItem(Config.ns + TOK_KEY,
              JSON.stringify({ token: this._token, expires }))
          } catch {}

          try {
            const r = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
              headers: { Authorization: `Bearer ${this._token}` },
            })
            this._user = await r.json()
            sessionStorage.setItem(Config.ns + USR_KEY, JSON.stringify(this._user))
          } catch { /* profile is cosmetic — carry on without it */ }

          // Courtesy check only. The real boundary is the Drive folder's ACL:
          // a disallowed account simply cannot read the content regardless of
          // what this branch does.
          if (this._user?.email && !(await isEmailAllowed(this._user.email))) {
            const who = this._user.email
            this.signOut()
            reject(new Error(`${who} doesn't have access to this hub.`))
            return
          }
          resolve(this._user)
        },
      })
      client.requestAccessToken({ prompt: '' })
    })
  },

  signOut() {
    if (this._token) { try { google.accounts.oauth2.revoke(this._token) } catch {} }
    this._token = null
    this._user  = null
    try {
      sessionStorage.removeItem(Config.ns + TOK_KEY)
      sessionStorage.removeItem(Config.ns + USR_KEY)
    } catch {}
  },

  /** Run a request; on 401 re-authorize once (coalesced) and retry. */
  async withAuthRetry(makeRequest) {
    let res = await makeRequest()
    if (res.status !== 401) return res
    if (!this._reauthInFlight) {
      this._reauthInFlight = this.signIn().catch(() => {})
      this._reauthInFlight.finally?.(() => { this._reauthInFlight = null })
    }
    try { await this._reauthInFlight } catch {}
    res = await makeRequest()
    if (res.status === 401) {
      this.signOut()
      window.dispatchEvent(new Event('gauth:expired'))
    }
    return res
  },

  /** Authenticated fetch — header is rebuilt per attempt so retries use the fresh token. */
  fetch(url, init = {}) {
    return this.withAuthRetry(() => {
      const headers = new Headers(init.headers || {})
      if (this._token) headers.set('Authorization', `Bearer ${this._token}`)
      return window.fetch(url, { ...init, headers })
    })
  },
}
