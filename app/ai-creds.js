/* The Azure OpenAI credentials every AI feature here borrows from the portal.
 *
 * Not from this repository, which is public. The PG Hub Tech portal keeps its
 * Azure OpenAI credentials in its Sheet's Settings tab and mirrors them into
 * localStorage under `pghtech_`. GitHub Pages serves both apps from one
 * origin, so that mirror is readable here. Where it is absent — a browser that
 * has never opened the portal, or localhost — the same Settings tab is read
 * directly, from the Sheet found in Drive by name; this app already asks for
 * the spreadsheets scope.
 *
 * Used by AI Note (chat). The speech deployment is read alongside the chat one
 * so voice practice can move onto this lookup too.
 */
import { Config, LS } from './config.js'
import { GAuth } from './gauth.js'

const PORTAL_NS = 'pghtech_'
const DEFAULTS  = {
  deployment: 'gpt-4o', apiVersion: '2024-12-01-preview',
  ttsVersion: '2025-03-01-preview', ttsVoice: 'nova',
}

function fromPortalMirror() {
  const ls = k => { try { return localStorage.getItem(PORTAL_NS + k) } catch { return null } }
  return {
    endpoint:      ls('aze') || '',
    apiKey:        ls('azk') || '',
    deployment:    ls('azd') || DEFAULTS.deployment,
    apiVersion:    ls('azv') || DEFAULTS.apiVersion,
    ttsEndpoint:   ls('aztep') || '',
    ttsKey:        ls('aztak') || '',
    ttsDeployment: ls('aztts') || '',
    ttsVersion:    ls('azttsv') || DEFAULTS.ttsVersion,
    ttsVoice:      ls('ttsv') || DEFAULTS.ttsVoice,
  }
}

/** The portal Sheet's Settings tab is `key | value`, one setting per row. */
async function fromPortalSheet(sheetId) {
  const r = await GAuth.fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/Settings!A:B`)
  if (!r.ok) throw new Error(`Could not read the portal's Settings tab (${r.status}).`)
  const s = Object.fromEntries(((await r.json()).values ?? []).map(row => [row[0], row[1] ?? '']))
  return {
    endpoint:      s.ai_endpoint || '',
    apiKey:        s.ai_api_key || '',
    deployment:    s.ai_deployment || DEFAULTS.deployment,
    apiVersion:    s.ai_api_version || DEFAULTS.apiVersion,
    ttsEndpoint:   s.ai_tts_endpoint || '',
    ttsKey:        s.ai_tts_api_key || '',
    ttsDeployment: s.ai_tts_deployment || '',
    ttsVersion:    s.ai_tts_api_version || DEFAULTS.ttsVersion,
    ttsVoice:      s.ai_tts_voice || DEFAULTS.ttsVoice,
  }
}

const sheetId = () => {
  let own = null
  try { own = localStorage.getItem(PORTAL_NS + 'sid') } catch {}
  return own || LS.get('ai_sid') || ''
}

/** Point the lookup at a Sheet by id, for a browser that cannot find it. */
export function useSheet(id) { LS.set('ai_sid', id); _creds = null }

/**
 * Find the portal's Sheet by name. The page knows which module it is, so the
 * reader should never be asked which spreadsheet to use: the content target is
 * the module's own Drive files, and the credentials Sheet is looked up here.
 * A candidate only counts if its Settings tab actually carries the key.
 */
async function discoverPortalSheet() {
  const names = Config.portalSheetNames.map(n => `name='${n.replace(/'/g, "\\'")}'`).join(' or ')
  const q = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and (${names})`
  const r = await GAuth.fetch('https://www.googleapis.com/drive/v3/files?fields=files(id)' +
    `&orderBy=modifiedTime desc&pageSize=10&q=${encodeURIComponent(q)}`)
  if (!r.ok) return null
  for (const f of (await r.json()).files ?? []) {
    try {
      const c = await fromPortalSheet(f.id)
      if (c.endpoint && c.apiKey) { LS.set('ai_sid', f.id); return c }
    } catch { /* not readable, or no Settings tab — try the next */ }
  }
  return null
}

let _creds = null
/** The portal's AI settings, or null when none can be found. Cached once found. */
export async function credentials() {
  if (_creds) return _creds
  const ok = c => c && c.endpoint && c.apiKey
  let c = fromPortalMirror()
  if (!ok(c) && sheetId()) c = await fromPortalSheet(sheetId()).catch(() => null)
  if (!ok(c)) c = await discoverPortalSheet()
  return ok(c) ? (_creds = c) : null
}
