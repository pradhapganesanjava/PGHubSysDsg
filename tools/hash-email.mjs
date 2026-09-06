#!/usr/bin/env node
// Print the SHA-256 an address needs in app/config.js allowedEmailHashes.
//   node tools/hash-email.mjs someone@example.com
import { createHash } from 'node:crypto'
const e = (process.argv[2] ?? '').trim().toLowerCase()
if (!e) { console.error('usage: node tools/hash-email.mjs <email>'); process.exit(1) }
console.log(createHash('sha256').update(e).digest('hex'))
