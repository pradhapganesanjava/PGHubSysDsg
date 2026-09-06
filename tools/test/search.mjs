#!/usr/bin/env node
/* Exercise app/search.js against a real index built from the live content.
 * Build one first:  node tools/build-search-index.mjs --dry-run
 */
import { mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir }        from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert            from 'node:assert/strict'

const __dir = dirname(fileURLToPath(import.meta.url))
const APP   = join(__dir, '..', '..', 'app')
const INDEX = join(__dir, '..', 'out', 'search-index.json')

let pass = 0, fail = 0
const test = async (name, fn) => {
  try { const n = await fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${n ? ' — ' + n : ''}`) }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`) }
}

const dir = await mkdtemp(join(tmpdir(), 'sysdsg-search-'))
await cp(APP, dir, { recursive: true })
const raw = await readFile(INDEX, 'utf8')
await writeFile(join(dir, 'drive.js'),
  `const IDX = ${raw}\nexport async function readRootJson(){ return IDX }\n`)

const S = await import(pathToFileURL(join(dir, 'search.js')).href)

console.log('\n  cross-module search\n')

await test('the index loads', async () => {
  await S.loadIndex()
  assert.ok(S.itemCount() > 1000)
  return `${S.itemCount()} items`
})

await test('finds a term by its exact title', async () => {
  const r = await S.query('consistent hashing')
  assert.ok(r.length, 'no results')
  assert.match(r[0].label.toLowerCase(), /consistent hashing/)
  return `top hit: ${r[0].label} (${r[0].typeName}, ${r[0].module})`
})

await test('matches a partial last word, as you type', async () => {
  const r = await S.query('consist')
  assert.ok(r.some(x => /consisten/i.test(x.label)), 'prefix did not expand')
  return `${r.length} hits`
})

await test('searches document text, not just titles', async () => {
  const r = await S.query('quorum')
  const docs = r.filter(x => x.type === 'doc')
  assert.ok(docs.length, 'no documents matched')
  return `${docs.length} of ${r.length} hits are documents`
})

await test('spans every module, not one', async () => {
  const r = await S.query('cache')
  const mods = new Set(r.map(x => x.module))
  assert.ok(mods.size >= 4, `only ${mods.size} module(s)`)
  return `${mods.size} modules`
})

await test('requires all words (AND, not OR)', async () => {
  const both = await S.query('bloom filter')
  const zero = await S.query('bloom zzzznotaword')
  assert.ok(both.length, 'expected hits for a real pair')
  assert.equal(zero.length, 0, 'a nonsense word should eliminate every hit')
  return `${both.length} vs 0`
})

await test('ranks a title match above a body mention', async () => {
  const r = await S.query('backpressure')
  assert.ok(/backpressure/i.test(r[0].label), `top hit was "${r[0].label}"`)
  return `top: ${r[0].label}`
})

await test('every result carries a working-looking link', async () => {
  const r = await S.query('kafka')
  assert.ok(r.length)
  for (const x of r) {
    assert.match(x.href, /^module\.html\?m=[^#]+#/, `bad href ${x.href}`)
  }
  const doc = r.find(x => x.type === 'doc')
  return doc ? `e.g. ${doc.href}` : `${r.length} hits`
})

await test('an empty query returns nothing rather than everything', async () => {
  assert.equal((await S.query('   ')).length, 0)
})

await test('a single letter does not hang the page', async () => {
  const t0 = Date.now()
  const r = await S.query('a')
  const ms = Date.now() - t0
  assert.ok(ms < 1500, `took ${ms}ms`)
  return `${r.length} hits in ${ms}ms`
})

await rm(dir, { recursive: true, force: true })
console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
