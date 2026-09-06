#!/usr/bin/env node
/**
 * Build the hub's cross-module search index and upload it to Drive.
 *
 * The hub could only ever filter titles, and documents were not in it at all —
 * 677 of them, the largest body of content, unreachable from the landing page.
 * This indexes everything: terms, Q&A, topics and documents, across all
 * modules, over their full text.
 *
 * WHY AN INVERTED INDEX
 * Shipping the text itself is not an option: it is 16 MB. Truncating it to fit
 * was measured at 0.91 MB gzipped while covering only 79% of items and 37% of
 * documents — a search that silently misses most of what it claims to cover.
 * An inverted index of the same corpus is 0.86 MB gzipped and covers all of it.
 * The trade is that results carry no snippet, which matches what the hub
 * already displayed.
 *
 * Postings are delta-encoded in base 36 and space-separated, which is both
 * smaller than a JSON array of integers and quicker for the browser to parse.
 *
 * Reads from Drive rather than disk, so it runs without a content checkout.
 *
 *   node tools/build-search-index.mjs [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'
import { gzipSync }            from 'node:zlib'

import { authorize } from './lib/auth.mjs'
import { driveClient, upsertText, withRetry } from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))
const STATE = join(__dir, '.migration-state.json')
const DRY   = process.argv.includes('--dry-run')

// Matches the tokenizer in app/search.js. Keeps +, #, . and - so "c++",
// "c#", "node.js" and "write-ahead" survive as single tokens.
const TOKEN = /[a-z0-9][a-z0-9+#._-]{1,}/g
const MAX_TOKEN = 24

const TYPES = { terms: 0, qa: 1, topics: 2, doc: 3 }
const FILES = [['terms', 'terms.json'], ['qa', 'qa.json'], ['topics', 'topics.json']]

const strip = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** First non-empty of the given fields, stripped — the item's display label. */
function labelOf(entry, keys) {
  for (const k of keys) {
    const t = strip(entry[k])
    if (t) return t
  }
  return entry.id ?? ''
}

async function main() {
  const state = JSON.parse(await readFile(STATE, 'utf8'))
  const drive = driveClient(await authorize())

  const get = async id => {
    const r = await withRetry('download', () =>
      drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' }))
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data
  }

  const hub = await get(state.hubJsonId)
  const mods = Object.keys(state.modules)

  const items = []          // [modIdx, typeIdx, id, label, group]
  const texts = []          // parallel: the full searchable text of each item

  console.log('\n  Indexing every module\n')

  for (const [mi, mod] of mods.entries()) {
    const ms = state.modules[mod]
    let n = 0

    for (const [kind, file] of FILES) {
      const id = ms.data?.[file]
      if (!id) continue
      const data = await get(id)
      for (const [key, v] of Object.entries(data)) {
        if (!v || typeof v !== 'object') continue
        const label = labelOf(v, kind === 'qa' ? ['question', 'title'] : ['title', 'summary'])
        // Every string field is searchable; the structural ones are not text.
        const body = Object.entries(v)
          .filter(([k]) => !['id', 'group', 'tag', 'builtin'].includes(k))
          .map(([, x]) => (typeof x === 'string' ? x : ''))
          .join(' ')
        items.push([mi, TYPES[kind], v.id ?? key, label, strip(v.group ?? '')])
        texts.push(strip(`${label} ${body}`))
        n++
      }
    }

    const di = ms.data?.['docs-index.json']
    if (di) {
      for (const d of await get(di)) {
        // `text` is what build-docs-index.py extracted from the HTML; markdown
        // docs carry their source instead.
        items.push([mi, TYPES.doc, d.name, d.title || d.name, (d.tag ?? '').trim()])
        texts.push(strip(`${d.title ?? ''} ${d.text || d.markdown || ''}`))
        n++
      }
    }
    console.log(`  ${mod.padEnd(18)} ${String(n).padStart(4)} item(s)`)
  }

  // ── invert ─────────────────────────────────────────────────────────────────
  const postings = new Map()
  texts.forEach((t, i) => {
    for (const w of new Set(t.toLowerCase().match(TOKEN) || [])) {
      if (w.length > MAX_TOKEN) continue
      let arr = postings.get(w)
      if (!arr) postings.set(w, arr = [])
      arr.push(i)
    }
  })

  const vocab = [...postings.keys()].sort()
  const post = vocab.map(w => {
    let prev = 0
    return postings.get(w).map(id => { const d = id - prev; prev = id; return d.toString(36) }).join(' ')
  })

  const index = {
    v: 1,
    built: new Date().toISOString(),
    mods,
    modTitles: mods.map(m => hub.modules?.[m]?.title ?? m),
    modEmoji:  mods.map(m => hub.modules?.[m]?.emoji ?? ''),
    items,
    vocab,
    post,
  }

  const json = JSON.stringify(index)
  const mb = n => (n / 1e6).toFixed(2) + ' MB'
  console.log(`\n  ${items.length} items, ${vocab.length} unique words`)
  console.log(`  ${mb(json.length)} raw, ${mb(gzipSync(json).length)} gzipped (Drive serves it compressed)`)

  if (DRY) {
    await writeFile(join(__dir, 'out', 'search-index.json'), json)
    console.log('\n  dry run — written to tools/out/search-index.json, Drive untouched\n')
    return
  }

  const r = await upsertText(drive, state.rootId, 'search-index.json', json)
  state.searchIndexId = r.id
  await writeFile(STATE, JSON.stringify(state, null, 2))
  console.log(`\n  uploaded → ${r.id}\n`)
}

main().catch(e => { console.error('\n  failed:', e.message, '\n'); process.exit(1) })
