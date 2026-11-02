/* AI Note — paste notes, say where they belong, get a filed term, Q&A or topic.
 *
 * A button after Search opens a chat drawer. The reader gives an instruction
 * and whatever they pasted; the model decides which kind it is and which group
 * it belongs under, writes the body in the page's own reading components, and
 * the result is shown as a draft. Nothing reaches Drive until Apply.
 *
 * WHERE THE KEY COMES FROM
 * Not from this repository, which is public: from the PG Hub Tech portal's
 * settings, through ./ai-creds.js.
 *
 * WHY TWO CALLS
 * The portal's noteGen.ts learned it first: HTML inside a JSON string escapes
 * badly and one long answer truncates the whole payload. So the first call
 * returns a small JSON plan (kind, group, title) and the second returns the
 * body as bare HTML.
 *
 * WHY IT WRITES THROUGH fetch() AND THEN RELOADS
 * The pages keep their own copies of every item in script-scope variables a
 * module cannot reach. POSTing to /terms, /qa or /topics goes through the
 * store exactly as the page's own Add dialogs do, and reloading with the hash
 * already on the new item redraws from what was just saved.
 */
import { Store, flush } from './store.js'
import { credentials, useSheet } from './ai-creds.js'

/* The reading components the model writes against are the page's own —
   .tldr, .note, .callout, .pan, .proscons, .chips, .flow, .diagram, all styled
   in module.html for authored content. Two the prompt asks for are not, so
   they are supplied here. Prepended, so a page that later grows its own rules
   for them wins. */
const COMPONENTS_CSS = `
.rich mark { background: var(--accent-soft); color: var(--text); border-bottom: 2px solid var(--accent); padding: 0 3px; border-radius: 3px; }
.recall {
  border: 1px dashed var(--accent); border-radius: 10px; background: var(--panel-2);
  padding: 10px 14px; margin: 14px 0; line-height: 1.6;
}
.recall::before { content: "\\1F9E0  "; }
`

// How the pages nest one group under another: "Scaling::Caching".
const TAG_SEP = '::'

const PLAN_TOKENS   = 800
const RENDER_TOKENS = 8000

const KINDS = {
  terms:  { noun: 'Term',  hash: id => '#' + id },
  qa:     { noun: 'Q&A',   hash: id => '#qa/' + id },
  topics: { noun: 'Topic', hash: id => '#topic/' + id },
}
// Which field names an item in the index the model reads. Mirrors hub-index.js.
const LABEL = { terms: ['title'], qa: ['question', 'title'], topics: ['title', 'summary'] }

const CSS = `
#pghub-ai {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100vw); z-index: 900;
  display: none; flex-direction: column; background: var(--panel); color: var(--text);
  border-left: 1px solid var(--border); box-shadow: -12px 0 32px rgba(0,0,0,.25);
}
#pghub-ai.open { display: flex; }
#pghub-ai .ai-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); font-weight: 700; font-size: 14px;
}
#pghub-ai .ai-head .sub { font-weight: 500; font-size: 12px; color: var(--muted); }
#pghub-ai .ai-head button { margin-left: auto; }
#pghub-ai .ai-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
#pghub-ai .msg { font-size: 13.5px; line-height: 1.55; border-radius: 10px; padding: 9px 12px; max-width: 100%; }
#pghub-ai .msg.user { align-self: flex-end; background: var(--accent-soft); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
#pghub-ai .msg.info { color: var(--muted); padding: 0 2px; }
#pghub-ai .msg.err  { border: 1px solid var(--danger, #e5534b); color: var(--danger, #e5534b); }
#pghub-ai .draft { border: 1px solid var(--border); border-radius: 12px; background: var(--bg); }
#pghub-ai .draft-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
#pghub-ai .draft-meta b { color: var(--accent); }
#pghub-ai .draft-body { padding: 14px; overflow-x: auto; }
#pghub-ai .draft-body h2 { font-size: 18px; margin: 0 0 6px; }
#pghub-ai .draft-body .lede { color: var(--muted); margin: 0 0 12px; font-size: 14px; }
#pghub-ai .draft-warn { padding: 8px 14px; font-size: 12.5px; color: var(--warn, #e3a008); border-top: 1px solid var(--border); }
#pghub-ai .draft-acts { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
#pghub-ai button.ai-btn {
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
  padding: 6px 13px; border-radius: 7px; cursor: pointer; font-size: 12.5px; font-weight: 600;
}
#pghub-ai button.ai-btn:hover { border-color: var(--accent); }
#pghub-ai button.ai-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink, #fff); }
#pghub-ai button.ai-btn:disabled { opacity: .55; cursor: default; }
#pghub-ai .ai-form { border-top: 1px solid var(--border); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
#pghub-ai textarea, #pghub-ai input[type=text] {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font: inherit; font-size: 13.5px; padding: 9px 11px;
}
#pghub-ai textarea { min-height: 110px; max-height: 40vh; resize: vertical; }
#pghub-ai textarea:focus, #pghub-ai input[type=text]:focus { outline: none; border-color: var(--accent); }
#pghub-ai .ai-row { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
#pghub-ai .ai-row button { margin-left: auto; }
`

// ── model ────────────────────────────────────────────────────────────────────

async function chat(messages, maxTokens, json = false) {
  const c = await credentials()
  if (!c) throw new Error('No AI credentials found.')
  const url = `${c.endpoint.replace(/\/$/, '')}/openai/deployments/${c.deployment}` +
              `/chat/completions?api-version=${c.apiVersion}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': c.apiKey },
    body: JSON.stringify({
      messages, max_completion_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error?.message || `AI request failed (${res.status})`)
  const choice = data.choices?.[0]
  return { content: choice?.message?.content?.trim() ?? '', truncated: choice?.finish_reason === 'length' }
}

// ── what the module already holds ────────────────────────────────────────────

const text = html => {
  const d = document.createElement('div')
  d.innerHTML = String(html ?? '')
  return (d.textContent || '').replace(/\s+/g, ' ').trim()
}
const escapeHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

async function loadIndex() {
  const out = {}
  for (const kind of Object.keys(KINDS)) {
    const r = await fetch('/' + kind)
    const map = r.ok ? await r.json() : {}
    out[kind] = Object.entries(map ?? {}).flatMap(([k, v]) => {
      if (!v || typeof v !== 'object') return []
      const label = LABEL[kind].map(f => text(v[f])).find(Boolean) || k
      return [{ id: v.id ?? k, group: v.group ?? '', label: label.slice(0, 110) }]
    })
  }
  return out
}

function describeIndex(index) {
  return Object.keys(KINDS).map(kind => {
    const groups = [...new Set(index[kind].map(i => i.group).filter(Boolean))].sort()
    return `## ${kind}\nGroups in use: ${groups.length ? groups.join(' ; ') : '(none yet)'}\n` +
      (index[kind].map(i => `- ${i.id} | ${i.group} | ${i.label}`).join('\n') || '(empty)')
  }).join('\n\n')
}

// ── prompts ──────────────────────────────────────────────────────────────────

const planPrompt = (mod, index) => `You file study notes into the "${mod}" module of a personal system design study hub.

The module holds three kinds of item:
- "terms": one concept, defined. A title, a one-sentence lede and an explanation.
- "qa": one interview-style question with its answer.
- "topics": a longer write-up covering several related ideas under one title.

Read the user's instruction and pasted notes and decide where ONE new item belongs.
- If the instruction names the kind (term, Q&A, topic), obey it. Otherwise pick the best fit.
- "group" is the heading it sits under. Reuse an existing group of that kind, spelled exactly, whenever one fits; invent a short new one only when none does. Groups nest with "${TAG_SEP}" ("Parent${TAG_SEP}Child").
- If an existing item of that kind already covers the same subject, put its id in "duplicateOf"; otherwise use "".

Reply with a JSON object and nothing else:
{"kind": "terms" | "qa" | "topics",
 "group": string,
 "title": string,        // terms and topics: the heading. qa: a 3-6 word label
 "question": string,     // qa only: the question as it would be asked, plain text
 "lede": string,         // terms only: one plain sentence saying what it is
 "summary": string,      // topics only: one or two plain sentences
 "duplicateOf": string}

What the module holds now (id | group | label):

${describeIndex(index)}`

const BODY_OF = {
  terms:  'the explanation shown under the term\'s title and lede',
  qa:     'the answer shown under the question',
  topics: 'the full write-up shown under the topic\'s title and summary',
}

const renderPrompt = (mod, plan, index) => `You write ${BODY_OF[plan.kind]} for the "${mod}" module of a personal system design study hub.

Output an HTML fragment and nothing else: no markdown, no code fence, no <html>, <body>, <style> or <script>, and do not repeat the title.

Content:
- Keep every fact, example and code sample from the user's notes. Correct obvious slips.
- Enrich it: fill the gaps a strong engineer would want filled, with accurate, specific detail. Do not pad.
- Write for fast re-reading. Prefer short bullets over paragraphs; no paragraph longer than two sentences.

Components the page already styles — use the ones that fit, in roughly this order:
- <div class="tldr">One sentence that answers it.</div> — first, exactly once.
- <h3>Section</h3> and <h4>Sub-section</h4> for structure (a topic needs several h3; a short answer may need none).
- <ul class="tight"><li>…</li></ul> for points; <ol class="tight"><li>…</li></ol> for a sequence.
- <div class="chips"><span class="chip">…</span>…</div> for a row of key terms, numbers or components; add class "go", "warn" or "trap" to colour one.
- <div class="note">…</div> for an aside; <div class="callout">…</div> for one takeaway. Add class "go" (best practice), "warn" (caution) or "trap" (pitfall) to either.
- <div class="callout tradeoff">…</div> for the trade-off at the heart of a design decision.
- <div class="scale"><div class="pan"><h4>Option A</h4>…</div><div class="vs">vs</div><div class="pan"><h4>Option B</h4>…</div></div> for two options weighed side by side.
- <div class="proscons"><div><h3>Pros</h3><ul>…</ul></div><div><h3>Cons</h3><ul>…</ul></div></div> for pros and cons.
- <table> for a comparison across three or more options or several dimensions.
- <div class="flow">Client → LB → Service → Cache → DB</div> for a request path or data flow, as plain text with arrows (whitespace is kept).
- For a topic describing an architecture, one <div class="diagram"><svg viewBox="…">…</svg></div> followed by <p class="diagram-cap">…</p>: boxes and arrows only, stroke and text in currentColor, no fixed background. Skip it if a flow says enough.
- <pre><code>…</code></pre> for code or config, with &lt; &gt; &amp; escaped. Inline <code> for identifiers.
- <mark>…</mark> for the few phrases worth remembering; <strong> sparingly.
- <div class="recall">A question to test yourself with.</div> — last, at most once.
- A link to another item that exists in this module: <a href="#TERM_ID">, <a href="#qa/ID"> or <a href="#topic/ID">. Only use ids from this list; never invent one:
${[...index.terms.map(i => `#${i.id}`), ...index.qa.map(i => `#qa/${i.id}`), ...index.topics.map(i => `#topic/${i.id}`)].slice(0, 400).join(' ') || '(none)'}

This item: kind=${plan.kind}, group="${plan.group}", title="${plan.title}"${plan.kind === 'qa' ? `, question="${plan.question}"` : ''}.`

// ── output handling ──────────────────────────────────────────────────────────

const DROP = 'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,foreignObject'

/** The model's HTML is stored and later set as innerHTML, so it is cleaned first. */
function sanitize(html) {
  const t = document.createElement('template')
  t.innerHTML = html.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '')
  t.content.querySelectorAll(DROP).forEach(n => n.remove())
  for (const el of t.content.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase()
      if (n.startsWith('on') || n === 'srcdoc' ||
          (/^(href|src|xlink:href|action|formaction)$/.test(n) && /^\s*(javascript|data|vbscript):/i.test(a.value))) {
        el.removeAttribute(a.name)
      }
    }
  }
  return t.innerHTML.trim()
}

function parsePlan(raw, index) {
  let p
  try { p = JSON.parse(raw.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '')) }
  catch { throw new Error('The model did not return a usable plan — try again.') }
  if (!KINDS[p.kind]) throw new Error(`The model chose an unknown kind: ${p.kind}`)
  const str = k => String(p[k] ?? '').trim()
  const plan = { kind: p.kind, group: str('group'), title: str('title'), question: str('question'),
                 lede: str('lede'), summary: str('summary'), duplicateOf: str('duplicateOf') }
  if (plan.kind === 'qa' && !plan.question) plan.question = plan.title
  if (!plan.title) plan.title = plan.question
  if (!plan.title) throw new Error('The model returned no title — try again.')
  if (!plan.group) plan.group = { terms: 'My Terms', qa: 'My Q&A', topics: 'My Topics' }[plan.kind]
  if (!index[plan.kind].some(i => i.id === plan.duplicateOf)) plan.duplicateOf = ''
  return plan
}

/** A new item in the shape the page's own Add dialog writes for that kind. */
function buildItem(plan, body, index) {
  const taken = new Set(index[plan.kind].map(i => i.id))
  const base  = slugify((plan.kind === 'qa' ? plan.question : plan.title).slice(0, 40)) ||
                { terms: 'term', qa: 'qa', topics: 'topic' }[plan.kind]
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`

  const { group } = plan
  if (plan.kind === 'qa')     return { id, group, question: escapeHtml(plan.question), answer: body, qa: true }
  if (plan.kind === 'topics') return { id, group, title: plan.title, summary: plan.summary, content: body, topic: true }
  const leaf = group.split(TAG_SEP).map(s => s.trim()).filter(Boolean).pop() || group
  return { id, title: plan.title, group, tag: leaf, lede: plan.lede, what: body, custom: true }
}

// ── panel ────────────────────────────────────────────────────────────────────

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}

export function installAiNote() {
  const tabs = document.querySelector('.tabs')
  // No module, no target: every write goes to Store.mod's own Drive folder,
  // so a page that does not know which module it is gets no button.
  if (!tabs || !Store.mod) return

  document.head.prepend(el('style', { textContent: COMPONENTS_CSS }))
  document.head.appendChild(el('style', { textContent: CSS }))

  const log    = el('div', { className: 'ai-log' })
  const input  = el('textarea', { placeholder: 'Say where it goes and paste your notes — e.g. “Add as a QA under Async: …”' })
  const send   = el('button', { className: 'ai-btn primary', type: 'button', textContent: 'Generate' })
  const status = el('span')
  const close  = el('button', { className: 'ai-btn', type: 'button', textContent: 'Close' })
  const panel  = el('div', { id: 'pghub-ai' },
    el('div', { className: 'ai-head' },
      el('span', { textContent: '✨ AI Note' }),
      el('span', { className: 'sub', textContent: `${Store.mod} · creates a Term, Q&A or Topic` }),
      close),
    log,
    el('div', { className: 'ai-form' }, input,
      el('div', { className: 'ai-row' }, status, send)))
  document.body.appendChild(panel)

  // Styled as a tab but deliberately without data-tab: the page's showTab()
  // only ever marks it inactive, and it opens a drawer rather than a view.
  const btn = el('button', { className: 'tab-btn', type: 'button', textContent: '✨ AI Note',
                             title: 'Turn pasted notes into a term, Q&A or topic' })
  tabs.appendChild(btn)

  const say = (cls, body) => {
    const m = el('div', { className: 'msg ' + cls })
    typeof body === 'string' ? (m.textContent = body) : m.append(body)
    log.appendChild(m)
    log.scrollTop = log.scrollHeight
    return m
  }

  // One draft at a time. `turns` is everything the reader has typed, so a
  // follow-up ("make it a topic", "shorter") revises rather than starts over.
  let turns = [], draft = null, busy = false

  const reset = () => { turns = []; draft = null }

  async function needCredentials() {
    try { if (await credentials()) return false } catch (e) { say('err', e.message) }
    const box  = el('input', { type: 'text', placeholder: 'Portal Sheet URL or id' })
    const save = el('button', { className: 'ai-btn', type: 'button', textContent: 'Use this sheet' })
    save.addEventListener('click', () => {
      const v = box.value.trim()
      const id = (v.match(/\/d\/([\w-]+)/) || [])[1] || v
      if (!id) return
      useSheet(id)
      say('info', 'Saved. Press Generate again.')
    })
    say('info', el('div', {},
      el('div', { textContent: 'No AI credentials in this browser. Open the PG Hub Tech portal once here, ' +
        'or point at its Sheet so the Settings tab can be read:' }),
      el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, box, save)))
    return true
  }

  async function generate() {
    const said = input.value.trim()
    if (!said || busy) return
    busy = true; send.disabled = true
    say('user', said)
    input.value = ''
    try {
      if (await needCredentials()) { input.value = said; return }
      turns.push(said)

      status.textContent = 'Reading the module…'
      const index = await loadIndex()

      status.textContent = 'Deciding where it goes…'
      const history = draft
        ? [{ role: 'assistant', content: JSON.stringify(draft.plan) },
           { role: 'user', content: 'Revise that plan for my latest message. Keep what I did not ask to change.' }]
        : []
      const planned = await chat([
        { role: 'system', content: planPrompt(Store.mod, index) },
        { role: 'user',   content: turns.join('\n\n---\n\n') },
        ...history,
      ], PLAN_TOKENS, true)
      const plan = parsePlan(planned.content, index)

      status.textContent = `Writing the ${KINDS[plan.kind].noun.toLowerCase()}…`
      const rendered = await chat([
        { role: 'system', content: renderPrompt(Store.mod, plan, index) },
        { role: 'user',   content: turns.join('\n\n---\n\n') },
        ...(draft ? [{ role: 'assistant', content: draft.body },
                     { role: 'user', content: 'Rewrite it for my latest message. Return the full fragment.' }] : []),
      ], RENDER_TOKENS)
      const body = sanitize(rendered.content)
      if (!text(body)) throw new Error('The model returned an empty body — try again.')

      draft = { plan, body, item: buildItem(plan, body, index), truncated: rendered.truncated }
      showDraft(index)
    } catch (e) {
      say('err', e.message)
    } finally {
      busy = false; send.disabled = false; status.textContent = ''
    }
  }

  function showDraft(index) {
    const { plan, body, item, truncated } = draft
    const kind = KINDS[plan.kind]
    const head = plan.kind === 'qa' ? plan.question : plan.title
    const sub  = plan.kind === 'terms' ? plan.lede : plan.kind === 'topics' ? plan.summary : ''

    const content = el('div', { className: 'draft-body' }, el('h2', { textContent: head }))
    if (sub) content.append(el('p', { className: 'lede', textContent: sub }))
    content.append(el('div', { className: 'rich', innerHTML: body }))
    // A cross-link would navigate the page out from under an unsaved draft.
    content.addEventListener('click', e => {
      if (e.target.closest?.('a[href^="#"]')) { e.preventDefault(); e.stopPropagation() }
    }, true)

    const apply   = el('button', { className: 'ai-btn primary', type: 'button', textContent: `Add ${kind.noun}` })
    const discard = el('button', { className: 'ai-btn', type: 'button', textContent: 'Discard' })
    const card = el('div', { className: 'draft' },
      el('div', { className: 'draft-meta' },
        el('b', { textContent: `New ${kind.noun}` }),
        el('span', { textContent: `in “${plan.group}” · id ${item.id}` })),
      content)

    const dup = plan.duplicateOf && index[plan.kind].find(i => i.id === plan.duplicateOf)
    if (dup) card.append(el('div', { className: 'draft-warn',
      textContent: `Looks close to an existing ${kind.noun}: “${dup.label}”. Adding this creates a second one.` }))
    if (truncated) card.append(el('div', { className: 'draft-warn',
      textContent: 'The answer hit the length limit and may be cut off. Ask for a shorter version before adding.' }))
    card.append(el('div', { className: 'draft-acts' }, apply, discard))

    say('', card).style.padding = '0'
    say('info', 'Type a change below to revise it, or add it as is.')

    const mine = draft
    discard.addEventListener('click', () => {
      if (draft === mine) reset()
      card.style.opacity = '.5'; apply.disabled = discard.disabled = true
      say('info', 'Discarded.')
    })
    apply.addEventListener('click', async () => {
      apply.disabled = discard.disabled = true
      apply.textContent = 'Saving…'
      try {
        const r = await fetch('/' + plan.kind, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
        })
        const out = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(out.error || `Save failed (${r.status})`)
        await flush()
        if (Store.pendingSaves) throw new Error('Drive did not accept the save — it is still queued; try again.')
        location.hash = kind.hash(item.id)
        location.reload()
      } catch (e) {
        say('err', e.message)
        apply.textContent = `Add ${kind.noun}`
        apply.disabled = discard.disabled = false
      }
    })
  }

  const toggle = open => {
    panel.classList.toggle('open', open)
    if (open) input.focus()
  }
  btn.addEventListener('click', () => toggle(!panel.classList.contains('open')))
  close.addEventListener('click', () => toggle(false))
  send.addEventListener('click', generate)
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); generate() }
  })
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false) })
}
