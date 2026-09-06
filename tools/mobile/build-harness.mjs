#!/usr/bin/env node
/**
 * Build an offline copy of the site for layout testing.
 *
 * The pages cannot be screenshotted as they ship: everything is behind a
 * Google sign-in, and the content comes from a private Drive folder. This
 * copies the real HTML, real CSS and real rendering code, and replaces only
 * two modules — the gate (so nothing blocks) and the Drive layer (so there is
 * content to lay out). What gets measured is therefore the actual stylesheet,
 * not an approximation of it.
 *
 * Fixtures deliberately include the awkward cases: a 600-character Q&A label,
 * deep tag nesting, and long document titles.
 */
import { cp, mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join }            from 'node:path'
import { fileURLToPath }            from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO  = join(__dir, '..', '..')
const OUT   = join(__dir, 'harness')

const LONG_QA = 'Metrics store for 100K machines — write-heavy, fast aggregated reads. ' +
  'Design a metrics system for 100K machines. A massive volume of writes arrives at high frequency, ' +
  'reads are aggregate queries over time windows, and the retention policy differs per resolution. ' +
  'Walk through ingestion, storage layout, rollups, and the query path.'

const mods = ['01-foundations','02-patterns','03-microservices','04-distributed','05-backend',
              '06-tradeoffs','07-technologies','08-designs','09-networking','10-lld',
              '11-concurrency','12-security','interview-prep']
const titles = ['Foundations','Patterns','Microservices','Distributed Systems','Backend Engineering',
                'Trade-offs','Technologies','Real-World Designs','Networking','Low-Level Design',
                'Concurrency','Security','Interview Prep']
const emoji = ['🧱','🧩','🔷','🌐','⚙️','⚖️','🛠️','🏗️','📡','📐','🧵','🔐','🎤']

const hub = {
  title: 'System Design Hub',
  tagline: 'Everything about system design — foundations, patterns, distributed systems, backend, trade-offs, worked designs — one launcher, each module its own app.',
  categories: [
    { name: 'Fundamentals', blurb: "The bedrock — core concepts, networking, and the 'it depends' decisions.", modules: ['01-foundations','09-networking','06-tradeoffs'] },
    { name: 'Architecture & Patterns', blurb: 'Reusable structures — design patterns, microservices, distributed systems.', modules: ['02-patterns','03-microservices','04-distributed'] },
    { name: 'Low-Level Design', blurb: 'Object-oriented design — the code-level counterpart to system design.', modules: ['10-lld'] },
    { name: 'Engineering', blurb: 'The build layer — backend internals, the concrete tech toolkit, and securing it all.', modules: ['05-backend','07-technologies','11-concurrency','12-security'] },
    { name: 'Practice', blurb: 'Put it together — full worked interview walkthroughs, and the interview round itself.', modules: ['08-designs','interview-prep'] },
  ],
  modules: Object.fromEntries(mods.map((d, i) => [d, {
    title: titles[i], emoji: emoji[i], sub: 'Scaling, consistency, caching, load balancing, replication, estimation.',
  }])),
}

const term = (id, title, group) => [id, { id, title, group,
  lede: 'A space-efficient probabilistic set. Answers definitely-not-present or probably-present.',
  what: '<p>A fixed-size bit array plus <code>k</code> hash functions. It never stores the keys.</p>',
  why:  '<p>Cheap pre-checks before expensive work.</p>' }]

const terms = Object.fromEntries([
  term('latency-throughput','Latency vs Throughput','Fundamentals'),
  term('availability','Availability','Fundamentals'),
  term('cap','CAP Theorem','Distributed Systems'),
  term('consistency','Consistency Models','Distributed Systems'),
  term('lb','Load Balancer','Scalability & Partitioning'),
  term('sharding','Sharding','Scalability & Partitioning'),
  term('consistent-hashing','Consistent Hashing','Scalability & Partitioning'),
  term('bloom','Bloom Filter','Data Structures'),
  term('wal','Write-Ahead Log (WAL) with a deliberately long name to test wrapping','Reliability'),
])
const qa = { q1: { id:'q1', question: LONG_QA, group:'Design', answer:'<p>Ingest, roll up, query.</p>' },
             q2: { id:'q2', question:'How does a load balancer decide where to send a request?', group:'Scalability', answer:'<p>Algorithms.</p>' } }
const topics = { t1: { id:'t1', title:'Core Concepts', group:'Overview', summary:'The ideas everything else builds on.', content:'<p>Body.</p>' } }

const docsIndex = [
  { name:'sd-bloom-filters.html', title:'Bloom Filters — System Design', type:'html', driveId:'D1', text:'bloom filter probabilistic', tag:'Caching::Strategies' },
  { name:'hi-11-caching.html', title:'Caching — a long document title that should not blow out the sidebar', type:'html', driveId:'D2', text:'caching', tag:'Caching::Invalidation & Eviction' },
  { name:'notes.md', title:'A Markdown Note', type:'markdown', driveId:'D3', markdown:'# A Markdown Note\n\nSome body text.', text:'note', tag:'Untagged' },
]

const GATE_STUB = `
import { markReady } from './ready.js'
export function installGate() { markReady() }   // layout harness: nothing blocks
`
const DRIVE_STUB = `
// Layout harness: fixed content so the pages have something realistic to lay out.
const HUB = ${JSON.stringify(hub)}
const TERMS = ${JSON.stringify(terms)}
const QA = ${JSON.stringify(qa)}
const TOPICS = ${JSON.stringify(topics)}
const DOCS_INDEX = ${JSON.stringify(docsIndex)}
const HUB_INDEX = { modules: ${JSON.stringify(mods)}.map((dir, i) => ({
  dir, title: ${JSON.stringify(titles)}[i], emoji: ${JSON.stringify(emoji)}[i],
  terms:  Object.values(TERMS).map(t => ({ id: t.id, label: t.title, group: t.group })),
  qa:     Object.values(QA).map(q => ({ id: q.id, label: q.question, group: q.group })),
  topics: Object.values(TOPICS).map(t => ({ id: t.id, label: t.title, group: t.group })),
})) }
// Same shape tools/build-search-index.mjs produces: sorted vocab, postings
// delta-encoded in base 36, items as [modIdx, typeIdx, id, label, group].
const SEARCH = (() => {
  const items = [
    [0, 0, 'bloom', 'Bloom Filter', 'Data Structures'],
    [0, 3, 'sd-bloom-filters.html', 'Bloom Filters — System Design', 'Caching::Strategies'],
    [0, 1, 'q1', ${JSON.stringify(LONG_QA)}, 'Design'],
    [7, 0, 'bloom2', 'Bloom Filter', 'Storage'],
    [7, 3, 'kv.html', 'Design a Key-Value Store — Single Machine → Distributed', 'Worked'],
    [9, 3, 'lld-bloom.html', 'Design Bloom Filter — Low Level Design (LLD)', 'Problems'],
  ]
  // every item contains 'bloom' except the long Q&A, which contains 'metrics'
  return { v: 1, mods: ${JSON.stringify(mods)}, modTitles: ${JSON.stringify(titles)},
           modEmoji: ${JSON.stringify(emoji)}, items,
           vocab: ['bloom', 'filter', 'metrics'],
           post: ['0 1 2 1', '0 1 4', '2'] }
})()

export async function readRootJson(name, fb) {
  if (name === 'hub.json') return HUB
  if (name === 'hub-index.json') return HUB_INDEX
  if (name === 'search-index.json') return SEARCH
  if (name in ROOT_FILES) return ROOT_FILES[name]
  return fb
}
export async function readModuleJson(mod, name, fb) {
  if (name === 'terms.json') return TERMS
  if (name === 'qa.json') return QA
  if (name === 'topics.json') return TOPICS
  if (name === 'docs-index.json') return DOCS_INDEX
  if (name === 'docs.json') return Object.fromEntries(DOCS_INDEX.map(d => [d.name, { tag: d.tag, tags: [] }]))
  return fb ?? {}
}
// A stand-in for the Drive root so settings.json round-trips like the real one.
const ROOT_FILES = {}
export async function writeModuleJson() { return 'id' }
export async function writeRootJson(name, data) { ROOT_FILES[name] = data; return 'id' }
export async function moduleFolderId() { return 'MOD' }
export async function findChild() { return null }
export async function listFolder() { return [] }
export async function readBlobById() { return new Blob(['<h1>Doc</h1>'], { type: 'text/html' }) }
export async function readTextById() { return '# Doc' }
export async function readJsonById(id, fb) { return fb ?? {} }
export async function createFile() { return 'NEW' }
export async function ensureFolder() { return 'F' }
export async function rootId() { return 'ROOT' }
export function clearIdCache() {}
`

await rm(OUT, { recursive: true, force: true })
await mkdir(join(OUT, 'app'), { recursive: true })
for (const f of ['index.html', 'module.html']) await cp(join(REPO, f), join(OUT, f))
await cp(join(REPO, 'app'), join(OUT, 'app'), { recursive: true })
await cp(join(REPO, 'vendor'), join(OUT, 'vendor'), { recursive: true })
await writeFile(join(OUT, 'app', 'gate.js'), GATE_STUB)
await writeFile(join(OUT, 'app', 'drive.js'), DRIVE_STUB)

// frame.html renders one page in an exactly-390px iframe. Screenshotting the
// frame rather than resizing the browser window guarantees the captured
// viewport is the width being claimed, so pictures and measurements agree.
await writeFile(join(OUT, 'frame.html'), `<!doctype html><meta charset="utf-8"><title>frame</title>
<style>html,body{margin:0;background:#222}iframe{width:390px;height:900px;border:0;display:block}</style>
<iframe id="f"></iframe>
<script>
  const p = new URLSearchParams(location.search);
  const f = document.getElementById('f');
  const w = p.get('w'); if (w) f.style.width = w + 'px';
  const h = p.get('h'); if (h) f.style.height = h + 'px';
  // Same origin, so the frame inherits whatever we seed here. Lets a state
  // that normally needs a tap — the sidebar being open — be captured.
  try {
    if (p.get('nav')) localStorage.setItem('agentai-nav-open', p.get('nav') === 'open' ? '1' : '0');
    if (p.get('theme')) localStorage.setItem('agentai-theme', p.get('theme'));
  } catch {}
  f.src = p.get('t') || 'index.html';
  // Lets a screenshot capture the theme menu, which otherwise needs a click.
  if (p.get('picker')) f.addEventListener('load', () => setTimeout(() => {
    f.contentDocument?.querySelector('#themeSwatches .tp-cur')?.click();
  }, 1200));
  const q = p.get('q');
  if (q) f.addEventListener('load', () => setTimeout(() => {
    const d = f.contentDocument, box = d && d.getElementById('mainSearch');
    if (!box) return;
    box.value = q;
    box.dispatchEvent(new f.contentWindow.Event('input', { bubbles: true }));
  }, 900));
</script>
`)

// diag.html reports horizontal overflow and names the outermost offenders.
await writeFile(join(OUT, 'diag.html'), `<!doctype html><meta charset="utf-8">
<title>overflow diagnostic</title>
<style>
 body{margin:0;font:12px/1.45 ui-monospace,Menlo,monospace;background:#0f1117;color:#e6e8ee}
 #out{padding:10px 12px;white-space:pre-wrap}
 h2{font:600 13px/1.4 system-ui;margin:14px 0 6px;color:#7aa2ff}
 iframe{position:absolute;left:-9999px;width:390px;height:900px;border:0}
 .bad{color:#ff9b9b}.ok{color:#8fe3a6}
</style>
<div id="out">measuring…</div>
<script>
const TARGETS = ['index.html', 'module.html?m=01-foundations'];
const W = 390;
const out = document.getElementById('out');
const lines = [];
function inspect(doc, label) {
  const de = doc.documentElement, b = doc.body;
  const scrollW = Math.max(de.scrollWidth, b.scrollWidth);
  lines.push('<h2>' + label + '</h2>');
  lines.push('viewport ' + W + 'px · document scrollWidth ' + scrollW + 'px  ' +
    (scrollW > W + 1 ? '<span class="bad">OVERFLOWS by ' + (scrollW - W) + 'px</span>'
                     : '<span class="ok">no horizontal overflow</span>'));
  if (scrollW <= W + 1) return;
  const bad = [];
  for (const el of doc.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= W + 1) continue;
    // A fixed element parked off-screen (the closed drawer) does not make the
    // document scroll; it would only add noise.
    if (doc.defaultView.getComputedStyle(el).position === 'fixed') continue;
    if (bad.some(pp => pp.el.contains(el))) continue;
    bad.push({ el, r });
  }
  for (const { el, r } of bad.slice(0, 14)) {
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className)
      ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
    const cs = doc.defaultView.getComputedStyle(el);
    lines.push('  <span class="bad">' + Math.round(r.right) + 'px</span>  ' +
      el.tagName.toLowerCase() + id + cls +
      '   [w ' + Math.round(r.width) + '  min-w ' + cs.minWidth + '  ws ' + cs.whiteSpace + ']');
  }
}
(async () => {
  for (const t of TARGETS) {
    const f = document.createElement('iframe');
    f.src = t;
    document.body.appendChild(f);
    await new Promise(r => { f.onload = r; setTimeout(r, 4000); });
    await new Promise(r => setTimeout(r, 1200));
    try { inspect(f.contentDocument, t); }
    catch (e) { lines.push('<h2>' + t + '</h2>  <span class="bad">' + e.message + '</span>'); }
  }
  out.innerHTML = lines.join('\\n');
})();
</script>
`)
// Diagnostic pages live beside this script as real files rather than as
// strings inside it — easier to edit, and they cannot break the build.
for (const f of ['themetest.html', 'docstest.html']) {
  try { await cp(join(__dir, f), join(OUT, f)) } catch { /* optional */ }
}
console.log('  harness built at', OUT)
