/* Voice practice: a spoken interview loop over the Practice card.
 *
 * The card itself is still drawn by the page's inline script. This listens for
 * each new card, reads the question aloud, then hands the floor to you:
 *
 *   speak ──► listen (your answer accumulates) ──► "submit" ──► AI review,
 *   spoken as it streams ──► listen (follow-ups go to the AI) ──► "next" ──► …
 *
 * Listening is the browser's Web Speech API. Speaking is PGHubTech's Azure
 * speech deployment only (asked of PGHubTech itself when it frames this page);
 * without one, questions and reviews show as text and the browser's built-in
 * voice is never used. The review is PGHubTech's Azure
 * OpenAI deployment, through ./voice-ai.js. Anything you can
 * say you can also type, which is also the whole interface in a browser
 * without speech recognition.
 *
 * The microphone is off while the page is talking. Otherwise recognition hears
 * the spoken audio and transcribes it as your answer.
 */
import { loadAiSettings, saveAiSettings, isConfigured, streamChat, canSpeak, speak } from './voice-ai.js'

const PREF = 'sysdsg-voice-prefs'          // speaking speed; per device
const SEND_FOLLOWUP_MS = 2200              // a pause this long sends a follow-up

const SR = window.SpeechRecognition || window.webkitSpeechRecognition

// ── commands ─────────────────────────────────────────────────────────────────
// Matched against a whole utterance once it is normalised, so "next" ends the
// question but "the next step is sharding" is part of your answer.
const COMMANDS = [
  ['repeat',     /^(repeat|repeat (the )?question|read (the )?question( again)?|say (it|that) again|again|pardon|come again)$/],
  ['repeatAi',   /^(repeat (the )?(feedback|review|that)|say the (feedback|review) again)$/],
  ['submit',     /^(submit|submit (my |the )?answer|done|i('| a)?m done|that('| i)?s (it|all|my answer)|(review|check) (my )?answer)$/],
  ['next',       /^(next|next question|skip|skip (it|this)|move on|new question|go next)$/],
  ['clear',      /^(clear|clear (my )?answer|start over|scratch that|reset)$/],
  ['reveal',     /^(reveal|show (me )?(the )?answer|read (the )?(model |reference )?answer|tell me the answer|what('| i)?s the answer)$/],
  ['hint',       /^(hint|give me a hint|any hints?)$/],
  ['readMine',   /^(read (back )?my answer|what did i say)$/],
  ['pause',      /^(pause|hold on|wait|stop listening)$/],
  ['resume',     /^(resume|continue|i('| a)?m back|go on|start listening)$/],
  ['slower',     /^(slower|slow down|speak slower)$/],
  ['faster',     /^(faster|speed up|speak faster)$/],
  ['help',       /^(help|commands|what can i say)$/],
  ['end',        /^(stop|stop voice|end|end (the )?session|exit|quit|goodbye)$/],
]
// Said at the end of a longer utterance, these still count: "… and that is how
// it scales. Submit."
const TRAILING_SUBMIT = /\s+(submit( my answer)?|that('| i)?s my answer|i('| a)?m done)$/

const HELP_TEXT = 'Say submit when your answer is complete. Repeat reads the question again. ' +
  'Next moves on. You can also say hint, read the answer, clear, pause, slower, faster, or stop.'

const norm = s => s.toLowerCase().replace(/[.,!?;:"]/g, '').replace(/\s+/g, ' ').trim()
// "Okay, can you repeat the question please" is still just "repeat the question".
const POLITE = /^((ok(ay)?|so|hey|um|uh|please|can you|could you|would you|let'?s|i want to|i'?d like to)\s+)+|\s+(please|now|thanks|thank you)$/g
const commandOf = text => {
  const t = text.replace(POLITE, '').replace(POLITE, '')
  return (COMMANDS.find(([, re]) => re.test(t)) || [])[0] || null
}

// ── state ────────────────────────────────────────────────────────────────────
const S = {
  on: false,
  mode: 'idle',          // idle | speaking | listening | thinking | paused
  phase: 'answer',       // answer: collecting your answer · discuss: after the review
  card: null,            // { title, kind, module, reference, hint }
  draft: [],             // final transcript chunks of the current answer / follow-up
  interim: '',
  convo: [],             // messages for the AI, reset per question
  lastAi: '',
  abort: null,           // AbortController of the in-flight AI request
  followTimer: 0,
  prefs: loadPrefs(),
}

function loadPrefs() {
  try { return { rate: 1, ...JSON.parse(localStorage.getItem(PREF) || '{}') } }
  catch { return { rate: 1 } }
}
function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify(S.prefs)) } catch {} }

// ── speaking ─────────────────────────────────────────────────────────────────
// Text is queued in chunks of a few sentences: a streaming review can start
// speaking before the AI has finished writing it, and the next chunk's audio
// is fetched from Azure while the current one plays. With no Azure voice the
// queue simply drains, so the loop carries on with text only.
const speech = {
  queue: [], busy: false, waiters: [], buf: '', audio: null, ctl: null, azureBroken: false,
  voiceOk: false,                       // set on start from canSpeak()
  azure() { return this.voiceOk && !this.azureBroken },
  say(text) {
    const max = 320
    let chunk = ''
    for (const p of String(text).match(/[^.!?\n]+[.!?]*/g) || []) {
      const t = p.trim()
      if (!t) continue
      if (chunk && chunk.length + t.length > max) { this.queue.push({ text: chunk }); chunk = '' }
      chunk = chunk ? `${chunk} ${t}` : t
    }
    if (chunk) this.queue.push({ text: chunk })
    this.prefetch()
    this.pump()
  },
  // Streamed text arrives mid-sentence; hold the tail until it is complete.
  feed(chunk) {
    this.buf += chunk
    const m = this.buf.match(/^[\s\S]*[.!?\n](\s|$)/)
    if (m) { this.say(m[0]); this.buf = this.buf.slice(m[0].length) }
  },
  flush() { if (this.buf.trim()) this.say(this.buf); this.buf = '' },
  prefetch() {
    const next = this.queue[0]
    if (!this.azure() || !next || next.url) return
    this.ctl ||= new AbortController()
    next.url = speak(next.text, this.ctl.signal)
    next.url.catch(() => {})            // handled where it is awaited
  },
  async pump() {
    if (this.busy) return
    if (!this.queue.length) { this.waiters.splice(0).forEach(f => f()); return }
    this.busy = true
    setMode('speaking')
    const item = this.queue.shift()
    if (this.azure()) {
      try {
        if (!item.url) { this.queue.unshift(item); this.prefetch(); this.queue.shift() }
        const url = await item.url
        if (!this.busy) return            // cancelled while fetching
        this.prefetch()
        await new Promise(res => {
          const a = this.audio = new Audio(url)
          a.playbackRate = S.prefs.rate
          a.onended = a.onerror = () => { URL.revokeObjectURL(url); res() }
          a.play().catch(res)
        })
        this.audio = null
        if (!this.busy) return
        this.busy = false
        return this.pump()
      } catch (e) {
        if (!this.busy) return
        this.azureBroken = true           // text only until settings are saved again
        note(`Azure voice failed (${e.message}). Continuing as text; fix it in settings.`)
      }
    }
    this.busy = false
    this.pump()
  },
  idle() {
    return (this.busy || this.queue.length || this.buf)
      ? new Promise(r => this.waiters.push(r)) : Promise.resolve()
  },
  cancel() {
    this.queue = []; this.buf = ''; this.busy = false
    this.ctl?.abort(); this.ctl = null
    if (this.audio) { this.audio.pause(); this.audio = null }
    this.waiters.splice(0).forEach(f => f())
  },
}

// A short rising tone: your turn.
let audioCtx
function cue() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime
    o.frequency.setValueAtTime(660, t); o.frequency.linearRampToValueAtTime(880, t + 0.12)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.22)
  } catch { /* no audio context: the status pill still says Listening */ }
}

/** Speak, then give the floor back. */
async function speakThenListen(text) {
  stopListening()
  speech.say(text)
  await speech.idle()
  if (S.on && S.mode !== 'thinking') listen()
}

// ── listening ────────────────────────────────────────────────────────────────
let rec = null, recWanted = false
function makeRecognizer() {
  const r = new SR()
  r.continuous = true
  r.interimResults = true
  r.lang = 'en-US'
  r.onresult = e => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]
      if (res.isFinal) onUtterance(res[0].transcript)
      else interim += res[0].transcript
    }
    S.interim = interim
    renderLive()
  }
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      recWanted = false
      note('Microphone blocked. Allow it in the address bar, or type below.')
      setMode('idle')
    }
    // no-speech / aborted / network: onend restarts if we still want it
  }
  // Recognition ends on its own after a stretch of silence; keep it going for
  // as long as it is your turn, since you were told the floor is yours.
  r.onend = () => { if (recWanted) setTimeout(() => { if (recWanted) try { r.start() } catch {} }, 250) }
  return r
}
function listen() {
  setMode(S.mode === 'paused' ? 'paused' : 'listening')
  if (!SR) return
  rec ||= makeRecognizer()
  if (!recWanted) { recWanted = true; try { rec.start() } catch {} }
  cue()
}
function stopListening() {
  recWanted = false
  S.interim = ''
  try { rec?.abort() } catch {}
}

function onUtterance(raw) {
  const text = raw.trim()
  if (!text) return
  const n = norm(text)
  const cmd = commandOf(n)
  if (S.mode === 'paused') { if (cmd === 'resume' || cmd === 'end') run(cmd); return }
  if (cmd) { run(cmd); return }
  if (S.phase === 'answer') {
    if (TRAILING_SUBMIT.test(n)) {
      S.draft.push(text.replace(/[\s,.]*(submit( my answer)?|that'?s my answer|that is my answer|i'?m done|i am done)[\s.!]*$/i, ''))
      run('submit'); return
    }
    S.draft.push(text)
    renderLive()
  } else {
    S.draft.push(text)
    renderLive()
    clearTimeout(S.followTimer)
    S.followTimer = setTimeout(sendFollowUp, SEND_FOLLOWUP_MS)
  }
}

// ── the card ─────────────────────────────────────────────────────────────────
// Read from the DOM the inline script just drew, so this never fetches or
// re-renders anything itself.
function readCard() {
  const card = document.getElementById('practiceCard')
  const q = card.querySelector('.practice-q')
  if (!q) return null
  const body = card.querySelector('.practice-body')
  const chips = [...card.querySelectorAll('.practice-mod .chip')].map(c => c.textContent.trim())
  return {
    title: q.textContent.trim(),
    kind: chips[1] === 'Term' ? 'term' : 'qa',
    module: chips[0] || '',
    group: chips[2] || '',
    reference: body ? plainText(body) : '',
    hint: body?.querySelector('.hint')?.textContent.replace(/^💡\s*/, '').trim() || '',
  }
}
// Answers carry SVG diagrams, code and styling; the AI and the voice want prose.
function plainText(el) {
  const c = el.cloneNode(true)
  c.querySelectorAll('svg,style,script,.hint').forEach(n => n.remove())
  c.querySelectorAll('br,p,div,li,h1,h2,h3,h4,h5,tr,pre').forEach(n => n.append('\n'))
  return c.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

function questionSpeech(c) {
  return c.kind === 'term' ? `Explain the term: ${c.title}.` : `Question. ${c.title}`
}

function startCard() {
  if (!S.on) return
  S.abort?.abort()
  clearTimeout(S.followTimer)
  speech.cancel()
  S.card = readCard()
  S.phase = 'answer'; S.draft = []; S.interim = ''; S.convo = []; S.lastAi = ''
  clearLog()
  if (!S.card) { note('No question on the card.'); return }
  log('q', S.card.title)
  speakThenListen(questionSpeech(S.card))
}

// ── AI review ────────────────────────────────────────────────────────────────
const SYSTEM = `You are a system design interview coach running a spoken practice session. \
Everything you write is read aloud by text-to-speech, so write plain spoken English: no markdown, \
no bullets or numbered lists, no headings, no code, no URLs, no emoji. Keep each reply under about \
120 words unless the candidate asks for more.

When the candidate submits an answer, compare it with the reference answer you are given. Begin \
with the score in exactly this form: "Score: 7 out of 10." Then say what they got right, the most \
important points they missed or got wrong, and one concrete tip for saying it better in an \
interview. The answer is a speech-to-text transcript, so technical words may be garbled: read \
generously and never mark someone down for a transcription error.

After the review the candidate may ask follow-up questions, ask you to explain a point, or argue \
with your assessment. Answer briefly and conversationally. Do not pose a new question yourself; \
the app moves between questions.`

function reviewPrompt(c, answer) {
  const what = c.kind === 'term' ? `Explain the term "${c.title}".` : c.title
  return `Module: ${c.module}${c.group ? ` · ${c.group}` : ''}\n\nQuestion: ${what}\n\n` +
    `Reference answer (for you only; the candidate has not seen it):\n${c.reference || '(none written)'}\n\n` +
    `Candidate's spoken answer:\n${answer}`
}

// Checked before an answer is taken off the draft, so it is still there to
// submit once settings are filled in.
function needsSettings() {
  if (isConfigured(loadAiSettings())) return false
  openSettings()
  speakThenListen('Add your Azure endpoint and key in settings first, then say submit again.')
  return true
}

async function ask(userText, label, onFail) {
  const settings = loadAiSettings()
  stopListening()
  clearTimeout(S.followTimer)
  S.convo.push({ role: 'user', content: userText })
  setMode('thinking')
  const bubble = log('ai', '')
  bubble.classList.add('pending')
  S.abort = new AbortController()
  let text = ''
  try {
    text = await streamChat(settings, {
      system: SYSTEM,
      messages: S.convo,
      signal: S.abort.signal,
      onText: d => {
        text += d
        bubble.textContent = text
        bubble.classList.remove('pending')
        speech.feed(d)
        scrollLog()
      },
    })
    bubble.textContent = text
    S.convo.push({ role: 'assistant', content: text })
    S.lastAi = text
    showScore(text)
  } catch (e) {
    if (e.name === 'AbortError' || S.abort?.signal.aborted) return
    S.convo.pop()
    onFail?.()                            // so the same words can be sent again
    bubble.classList.add('err')
    bubble.textContent = `${label} failed: ${e.message || e}`
    speech.say(`Sorry, the review failed. ${e.status === 401 || e.status === 403 ? 'Check your key in settings.' : 'Say submit to try again.'}`)
  } finally {
    bubble.classList.remove('pending')
    speech.flush()
    S.abort = null
  }
  await speech.idle()
  if (S.on && S.mode !== 'idle') listen()
}

function showScore(text) {
  const m = text.match(/score:?\s*(\d+(?:\.\d)?)\s*(?:out of|\/)\s*10/i)
  if (m) document.getElementById('vpScore').textContent = `${m[1]}/10`
}

function sendFollowUp() {
  const t = S.draft.join(' ').trim()
  if (!t || S.phase !== 'discuss' || S.mode === 'thinking' || needsSettings()) return
  S.draft = []; renderLive()
  log('you', t)
  ask(t, 'Follow-up', () => { S.draft = [t]; renderLive() })
}

// ── commands ─────────────────────────────────────────────────────────────────
function run(cmd) {
  if (!S.on) return
  switch (cmd) {
    case 'repeat':
      if (S.card) speakThenListen(questionSpeech(S.card)); break
    case 'repeatAi':
      speakThenListen(S.lastAi || 'There is no feedback yet.'); break
    case 'submit': {
      if (S.phase === 'discuss') { sendFollowUp(); break }
      const answer = S.draft.join(' ').trim()
      if (!answer) { speakThenListen("I haven't heard an answer yet. Take your time."); break }
      if (needsSettings()) break
      S.draft = []; renderLive()
      log('you', answer)
      S.phase = 'discuss'
      ask(reviewPrompt(S.card, answer), 'Review', () => { S.phase = 'answer'; S.draft = [answer]; renderLive() })
      break
    }
    case 'next':
      stopListening(); speech.cancel(); S.abort?.abort()
      window.practiceNext?.()              // the card event that follows restarts the loop
      break
    case 'clear':
      S.draft = []; renderLive(); speakThenListen('Cleared. Go ahead.'); break
    case 'reveal':
      if (S.card) { log('ref', S.card.reference || 'No answer written yet.'); speakThenListen(S.card.reference || 'No answer has been written for this one yet.') }
      break
    case 'hint':
      speakThenListen(S.card?.hint || 'There is no hint for this one.'); break
    case 'readMine':
      speakThenListen(S.draft.join(' ') || 'You have not said anything yet.'); break
    case 'pause':
      stopListening(); speech.cancel(); setMode('paused')
      if (SR) { recWanted = true; try { rec.start() } catch {} }  // still hear "resume"
      break
    case 'resume':
      setMode('listening'); listen(); break
    case 'slower':
      S.prefs.rate = Math.max(0.6, +(S.prefs.rate - 0.15).toFixed(2)); savePrefs(); renderRate(); speakThenListen('Slower.'); break
    case 'faster':
      S.prefs.rate = Math.min(1.8, +(S.prefs.rate + 0.15).toFixed(2)); savePrefs(); renderRate(); speakThenListen('Faster.'); break
    case 'help':
      speakThenListen(HELP_TEXT); break
    case 'end':
      stop(); break
  }
}

// ── start / stop ─────────────────────────────────────────────────────────────
async function start() {
  if (S.on) return
  S.on = true
  panel().hidden = false
  document.getElementById('practiceVoice').classList.add('active')
  if (!SR) note('This browser has no speech recognition (Chrome, Edge and Safari do). You can still type answers and commands.')
  speech.voiceOk = await canSpeak()
  if (!speech.voiceOk) note('No Azure voice set up, so questions and feedback show as text. Add the TTS deployment in PGHubTech Settings (or below) to hear them.')
  // Reviews are per question, so open on the card already showing.
  startCard()
}
function stop() {
  if (!S.on) return
  S.on = false
  stopListening(); speech.cancel(); S.abort?.abort(); clearTimeout(S.followTimer)
  setMode('idle')
  panel().hidden = true
  document.getElementById('practiceVoice').classList.remove('active')
}

window.__sysdsgVoice = { start, stop, get on() { return S.on } }
document.addEventListener('practice:card', () => { if (S.on) startCard() })

// ── UI ───────────────────────────────────────────────────────────────────────
const panel = () => document.getElementById('voicePanel')
const STATE_LABEL = { idle: 'Off', speaking: '🔊 Speaking', listening: '🎙 Your turn', thinking: '🤔 Reviewing', paused: '⏸ Paused' }

function setMode(m) {
  S.mode = m
  const el = document.getElementById('vpState')
  if (!el) return
  el.textContent = STATE_LABEL[m]
  el.dataset.mode = m
  document.getElementById('vpPause').textContent = m === 'paused' ? '▶ Resume' : '⏸ Pause'
}

function log(who, text) {
  const d = document.createElement('div')
  d.className = `vp-msg ${who}`
  d.textContent = text
  document.getElementById('vpLog').append(d)
  scrollLog()
  return d
}
function note(text) { log('sys', text) }
function clearLog() { document.getElementById('vpLog').textContent = ''; document.getElementById('vpScore').textContent = '' }
function scrollLog() { const l = document.getElementById('vpLog'); l.scrollTop = l.scrollHeight }

function renderLive() {
  const el = document.getElementById('vpLive')
  const said = S.draft.join(' ')
  el.innerHTML = ''
  if (!said && !S.interim) {
    el.textContent = S.phase === 'answer' ? 'Your answer appears here as you speak.' : 'Ask a follow-up, or say "next".'
    el.classList.add('empty')
    return
  }
  el.classList.remove('empty')
  el.append(said + ' ')
  if (S.interim) { const i = document.createElement('span'); i.className = 'interim'; i.textContent = S.interim; el.append(i) }
}

function renderRate() { const r = document.getElementById('vpRate'); if (r) { r.value = S.prefs.rate; r.nextElementSibling.textContent = `${S.prefs.rate}×` } }

function openSettings() { document.getElementById('vpSettingsBox').open = true }

const FIELDS = ['endpoint', 'deployment', 'apiVersion', 'key', 'ttsDeployment', 'ttsVoice']
const fieldEl = f => document.getElementById('vp-' + f)

function fillSettings() {
  const s = loadAiSettings()
  for (const f of FIELDS) {
    const el = fieldEl(f)
    el.value = s[f] || ''
    el.closest('label').classList.toggle('inherited', s.from[f] === 'pghubtech')
  }
  const src = Object.values(s.from).includes('pghubtech')
  document.getElementById('vpSource').textContent = isConfigured(s)
    ? (src ? 'Using the Azure settings from PGHubTech. Change any field to override it for this page.' : 'Using the settings saved on this page.')
    : 'No Azure OpenAI settings found. Set them in PGHubTech, or fill them in here.'
}

function wire() {
  document.getElementById('practiceVoice').onclick = () => (S.on ? stop() : start())
  document.getElementById('vpSkip').onclick = () => { speech.cancel(); if (S.on && S.mode !== 'thinking' && S.mode !== 'paused') listen() }
  document.getElementById('vpPause').onclick = () => run(S.mode === 'paused' ? 'resume' : 'pause')
  document.querySelectorAll('#voicePanel [data-cmd]').forEach(b => { b.onclick = () => run(b.dataset.cmd) })
  document.getElementById('vpForm').onsubmit = e => {
    e.preventDefault()
    const box = document.getElementById('vpText')
    const t = box.value.trim()
    box.value = ''
    if (!t) return
    const cmd = commandOf(norm(t))
    if (cmd) return run(cmd)
    // Typed text is a finished thought: it submits (or sends) straight away,
    // along with anything already spoken.
    S.draft.push(t)
    run('submit')
  }
  document.getElementById('vpSave').onclick = () => {
    saveAiSettings(Object.fromEntries(FIELDS.map(f => [f, fieldEl(f).value.trim()])))
    speech.azureBroken = false
    canSpeak().then(ok => { speech.voiceOk = ok })
    fillSettings()
    document.getElementById('vpSettingsBox').open = false
    if (S.on) note('Settings saved on this device.')
  }
  document.getElementById('vpSettingsBox').ontoggle = e => { if (e.target.open) fillSettings() }
  document.getElementById('vpRate').oninput = e => { S.prefs.rate = +e.target.value; savePrefs(); renderRate() }
  fillSettings()
  renderRate()
  renderLive()
}
wire()
