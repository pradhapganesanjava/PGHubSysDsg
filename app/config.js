/* SysDsgHub — runtime configuration.
 *
 * This file ships in a PUBLIC repository. It deliberately contains no Drive
 * folder ids, no file ids, and no email addresses: everything identifying is
 * either resolved at runtime (folder lookup by name, after sign-in) or stored
 * as a one-way hash. The OAuth client id below is public by design — Google
 * treats it as an identifier, not a secret, and it is useless without a user
 * consenting in a browser.
 *
 * WHERE SECURITY ACTUALLY COMES FROM
 * ----------------------------------
 * Not from this file. The content lives in a private Google Drive folder owned
 * by one account; Drive's own ACL is what keeps it private. ALLOWED_EMAIL_HASHES
 * below is a courtesy check so a stray visitor gets a clear "this isn't your
 * hub" message instead of a wall of Drive 404s — it is NOT a security boundary,
 * because anyone can edit client-side JavaScript. Do not add anything here that
 * would be harmful to read.
 */
export const Config = {
  // Public OAuth client id (Google Cloud project: pg-hub-tech). Overridable at
  // build time so a fork can point at its own project without editing source.
  clientId:
    (typeof __GOOGLE_CLIENT_ID__ !== 'undefined' && __GOOGLE_CLIENT_ID__) ||
    '650455977557-q0tunhbtfb2qabnhts5q6dac47b2q3iq.apps.googleusercontent.com',

  // Name of the Drive folder holding everything. Resolved to an id after
  // sign-in and cached in localStorage — the id itself is never committed.
  rootFolderName: 'SysDsgHub',
  manifestSheetName: 'SysDsgHub Manifest',

  /* Scopes.
   *
   * `drive.file` grants access per-file to files the *application* created,
   * where the application is the Google Cloud project — and the migration tool
   * (Desktop client) shares project pg-hub-tech with this Web client, so the
   * content it uploaded is reachable here for both read and write.
   *
   * `drive.readonly` is kept as a safety net: if per-project file access ever
   * does not apply, reads still work and the app degrades to read-only rather
   * than showing an empty hub. If you see 403s on SAVE (not on load), swap the
   * two entries below for the single scope
   * 'https://www.googleapis.com/auth/drive' and re-consent once.
   */
  scopes: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],

  // SHA-256 of each lowercased, trimmed address allowed to use this hub.
  // Empty array => any Google account may sign in (Drive ACLs still apply).
  // (hash of the hub owner's Google address; regenerate with tools/hash-email.mjs)
  allowedEmailHashes: [
    'a6037f7a3a641a2508b322bd6be71ce3389554d7f1228dc901d63010804bba2b',
  ],

  // localStorage namespace
  ns: 'sysdsg_',
}

/** SHA-256 hex of a string — used for the courtesy email check. */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function isEmailAllowed(email) {
  if (!Config.allowedEmailHashes.length) return true
  const h = await sha256Hex(String(email || '').trim().toLowerCase())
  return Config.allowedEmailHashes.includes(h)
}

export const LS = {
  get:  k => localStorage.getItem(Config.ns + k),
  set:  (k, v) => { try { localStorage.setItem(Config.ns + k, v) } catch {} },
  del:  k => { try { localStorage.removeItem(Config.ns + k) } catch {} },
}
