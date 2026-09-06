/* Cross-module full-text search for the landing page.
 *
 * The hub could only filter the titles it had already rendered, and documents
 * were absent from that list entirely. This searches the full text of every
 * term, Q&A, topic and document in every module, against the index baked by
 * tools/build-search-index.mjs.
 *
 * The index is an inverted one — word to the items containing it — because the
 * text itself is 16 MB. It is fetched once, on the first search rather than at
 * page load, so opening the hub costs nothing.
 *
 * Matching follows what people expect while typing: every word but the last
 * must match exactly, and the last is treated as a prefix, so "consist" finds
 * "consistency" mid-keystroke. All words must be present (AND).
 */
import { readRootJson } from './drive.js'

// Must stay in step with the tokenizer in tools/build-search-index.mjs.
const TOKEN = /[a-z0-9][a-z0-9+#._-]{1,}/g

// A one- or two-letter prefix can match tens of thousands of words; expanding
// all of them would stall the page for no benefit, since the result set would
// be everything anyway.
const MAX_PREFIX_WORDS = 400

const TYPE_NAME = ['Term', 'Q&A', 'Topic', 'Doc']
const TYPE_KEY  = ['terms', 'qa', 'topics', 'doc']

let _index = null
let _loading = null
const _postingCache = new Map()

/** Fetch and cache the index. Safe to call repeatedly. */
export function loadIndex() {
  if (_index) return Promise.resolve(_index)
  return _loading ??= readRootJson('search-index.json', null)
    .then(idx => {
      if (!idx?.vocab) throw new Error('search index not found in Drive')
      _index = idx
      return idx
    })
    .finally(() => { _loading = null })
}

export function isReady() { return !!_index }
export function itemCount() { return _index?.items.length ?? 0 }

/** Postings for vocab entry i, decoded from its delta-encoded base-36 string. */
function postingsAt(i) {
  let p = _postingCache.get(i)
  if (p) return p
  const raw = _index.post[i]
  p = []
  let prev = 0
  if (raw) for (const d of raw.split(' ')) { prev += parseInt(d, 36); p.push(prev) }
  _postingCache.set(i, p)
  return p
}

/** First vocab position whose word is >= target. */
function lowerBound(target) {
  const v = _index.vocab
  let lo = 0, hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (v[mid] < target) lo = mid + 1; else hi = mid
  }
  return lo
}

function exactMatches(word) {
  const i = lowerBound(word)
  return _index.vocab[i] === word ? [i] : []
}

function prefixMatches(prefix) {
  const out = []
  for (let i = lowerBound(prefix); i < _index.vocab.length; i++) {
    if (!_index.vocab[i].startsWith(prefix)) break
    out.push(i)
    if (out.length >= MAX_PREFIX_WORDS) break
  }
  return out
}

function unionOf(vocabPositions) {
  const set = new Set()
  for (const i of vocabPositions) for (const id of postingsAt(i)) set.add(id)
  return set
}

/**
 * Search the index.
 * @returns {Array} ranked results: {module, moduleTitle, emoji, type, typeName,
 *                                   id, label, group, href}
 */
export async function query(text, limit = 200) {
  const words = (String(text).toLowerCase().match(TOKEN) || [])
  if (!words.length) return []
  await loadIndex()

  let hits = null
  words.forEach((w, n) => {
    const last = n === words.length - 1
    const positions = last ? prefixMatches(w) : exactMatches(w)
    const set = unionOf(positions)
    if (hits === null) hits = set
    else for (const id of hits) if (!set.has(id)) hits.delete(id)
  })
  if (!hits?.size) return []

  const lowered = words.join(' ')
  const scored = []
  for (const id of hits) {
    const [mi, type, itemId, label, group] = _index.items[id]
    const hay = label.toLowerCase()
    // A title match is what the user almost always means; a whole-phrase title
    // match more so. Everything else ranks by how early the module appears,
    // which keeps results from one module together rather than interleaved.
    let score = 0
    if (hay.includes(lowered)) score += 200
    for (const w of words) if (hay.includes(w)) score += 50
    if (type === 3) score -= 5              // documents are bulkier, slightly demote
    scored.push({ id, score, mi, type, itemId, label, group })
  }
  scored.sort((a, b) => b.score - a.score || a.mi - b.mi || a.label.localeCompare(b.label))

  return scored.slice(0, limit).map(r => ({
    module:      _index.mods[r.mi],
    moduleTitle: _index.modTitles[r.mi],
    emoji:       _index.modEmoji[r.mi],
    type:        TYPE_KEY[r.type],
    typeName:    TYPE_NAME[r.type],
    id:          r.itemId,
    label:       r.label,
    group:       r.group,
    href:        hrefFor(_index.mods[r.mi], r.type, r.itemId),
  }))
}

function hrefFor(mod, type, id) {
  const m = encodeURIComponent(mod)
  const i = encodeURIComponent(id)
  if (type === 0) return `module.html?m=${m}#${i}`
  if (type === 1) return `module.html?m=${m}#qa/${i}`
  if (type === 2) return `module.html?m=${m}#topic/${i}`
  return `module.html?m=${m}#doc/${i}`
}
