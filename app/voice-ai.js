/* The AI behind voice practice: the same Azure OpenAI deployment PGHubTech uses.
 *
 * Speech goes through PGHubTech itself when it is framing this page: we post
 * the text, the portal runs its own Azure TTS (LLM.ttsAzureBlob, with the
 * credentials it hydrates from the Sheet) and posts the audio back. Standalone,
 * the same Azure call is made from here.
 *
 * PGHubTech (the portal at /pghubtech/) already keeps its Azure settings in
 * localStorage under pghtech_*, and both sites are served from the same
 * github.io origin, so they are read from there with nothing to configure.
 * Anything saved in this page's own settings overrides them, and is the only
 * source on localhost, where the origin differs.
 *
 * Request shapes match portal/src/lib/llm.ts: chat with the `api-key` header,
 * speech with a Bearer token. Chat is streamed here so a review can start
 * being spoken before it has finished being written.
 *
 * Keys live only in this browser's storage, never in Drive or the repo.
 */
import { TRUSTED, framed } from './parent-auth.js'

const OWN = 'sysdsg-voice-ai'
const PGH = 'pghtech_'

const DEFAULTS = {
  endpoint: '', key: '', deployment: 'gpt-4o', apiVersion: '2024-12-01-preview',
  ttsEndpoint: '', ttsKey: '', ttsDeployment: '', ttsVersion: '2025-03-01-preview', ttsVoice: 'nova',
}
// Our field → the portal's localStorage key (see portal/src/services/config.ts).
const FROM_PGH = {
  endpoint: 'aze', key: 'azk', deployment: 'azd', apiVersion: 'azv',
  ttsEndpoint: 'aztep', ttsKey: 'aztak', ttsDeployment: 'aztts', ttsVersion: 'azttsv', ttsVoice: 'ttsv',
}

const get = k => { try { return localStorage.getItem(k) } catch { return null } }

function own() { try { return JSON.parse(get(OWN) || '{}') } catch { return {} } }

/** Settings in effect: this page's own, else PGHubTech's, else defaults. */
export function loadAiSettings() {
  const mine = own(), s = { ...DEFAULTS }, from = {}
  for (const f of Object.keys(DEFAULTS)) {
    const pgh = FROM_PGH[f] ? get(PGH + FROM_PGH[f]) : null
    if (mine[f]) { s[f] = mine[f]; from[f] = 'here' }
    else if (pgh) { s[f] = pgh; from[f] = 'pghubtech' }
  }
  s.from = from
  return s
}

/** Save only what differs from what would be inherited, so a later change in
 *  PGHubTech still comes through for every field left alone here. */
export function saveAiSettings(next) {
  const mine = own()
  const inherited = loadAiSettings()
  for (const [f, v] of Object.entries(next)) {
    if (!(f in DEFAULTS)) continue
    if (!v) delete mine[f]
    else if (v !== inherited[f] || inherited.from[f] === 'here') mine[f] = v
  }
  try { localStorage.setItem(OWN, JSON.stringify(mine)) } catch {}
}

export const isConfigured = s => !!(s.endpoint && s.key)
export const hasAzureVoice = s => !!(s.ttsDeployment && (s.ttsKey || s.key))

// The page's fetch is the Drive store's; cross-origin calls only pass through
// it, so go straight to the browser's.
const rawFetch = (...a) => (window.__sysdsgNativeFetch || fetch)(...a)

async function failure(res, what) {
  const err = await res.json().catch(() => ({}))
  const e = new Error(err.error?.message || `${what} HTTP ${res.status}`)
  e.status = res.status
  return e
}

/**
 * Stream one chat completion. onText gets each delta; resolves to the full text.
 * messages are {role, content}; the system prompt goes first as its own message.
 */
export async function streamChat(s, { system, messages, onText, signal }) {
  if (!isConfigured(s)) throw new Error('Azure OpenAI is not configured. Open settings to add the endpoint and key.')
  const url = `${s.endpoint.replace(/\/$/, '')}/openai/deployments/${s.deployment}/chat/completions?api-version=${s.apiVersion}`
  const res = await rawFetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'api-key': s.key },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, ...messages],
      max_completion_tokens: 1500,
      stream: true,
    }),
  })
  if (!res.ok) throw await failure(res, 'Chat')

  // Server-sent events: `data: {json}` lines, ending with `data: [DONE]`.
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', full = '', finish = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim()
      if (!data || data === '[DONE]' || !line.startsWith('data:')) continue
      let j
      try { j = JSON.parse(data) } catch { continue }
      const c = j.choices?.[0]
      if (c?.finish_reason) finish = c.finish_reason
      const d = c?.delta?.content
      if (d) { full += d; onText?.(d) }
    }
  }
  if (finish === 'content_filter') throw new Error('Azure content filter stopped the reply.')
  return full.trim()
}

// ── speech through the host ─────────────────────────────────────────────────
// A PGHubTech build without the bridge never answers the hello, and then
// speech is made here instead.
const pending = new Map()
let hostOrigin = null, seq = 0
const hostReady = new Promise(resolve => {
  if (!framed()) return resolve(false)
  window.addEventListener('message', e => {
    if (e.source !== window.parent || !TRUSTED.includes(e.origin)) return
    const d = e.data
    if (d?.type === 'pghubtech:tts-hello') { hostOrigin = e.origin; resolve(true) }
    else if (d?.type === 'pghubtech:tts-result' && pending.has(d.id)) {
      const p = pending.get(d.id)
      pending.delete(d.id)
      d.error ? p.reject(new Error(d.error)) : p.resolve(URL.createObjectURL(new Blob([d.audio], { type: 'audio/mpeg' })))
    }
  })
  for (const o of TRUSTED) { try { window.parent.postMessage({ type: 'pghubtech:tts-hello' }, o) } catch {} }
  setTimeout(() => resolve(false), 3000)
})

function hostSpeech(text, signal) {
  return new Promise((resolve, reject) => {
    const id = `t${++seq}`
    pending.set(id, { resolve, reject })
    signal?.addEventListener('abort', () => {
      if (pending.delete(id)) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
    window.parent.postMessage({ type: 'pghubtech:tts', id, text }, hostOrigin)
  })
}

/** Whether there is any Azure voice to speak with: the host's, or our own settings. */
export async function canSpeak() {
  return (await hostReady) || hasAzureVoice(loadAiSettings())
}

/** Text to an mp3 object URL: through PGHubTech when it frames us, else directly. */
export async function speak(text, signal) {
  if (await hostReady) return hostSpeech(text, signal)
  const s = loadAiSettings()
  if (!hasAzureVoice(s)) throw new Error('no Azure TTS deployment configured')
  return azureSpeech(s, text, signal)
}

/** Text to an mp3 object URL through the Azure speech deployment. */
export async function azureSpeech(s, text, signal) {
  const ep = (s.ttsEndpoint || s.endpoint).replace(/\/$/, '')
  const res = await rawFetch(`${ep}/openai/deployments/${s.ttsDeployment}/audio/speech?api-version=${s.ttsVersion}`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.ttsKey || s.key}` },
    body: JSON.stringify({ model: s.ttsDeployment, input: text, voice: s.ttsVoice, response_format: 'mp3' }),
  })
  if (!res.ok) throw await failure(res, 'Speech')
  return URL.createObjectURL(await res.blob())
}
