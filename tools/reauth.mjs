#!/usr/bin/env node
/**
 * Re-authorize the command-line tooling.
 *
 * The saved refresh token can stop working — Google expires them for a consent
 * screen still in Testing mode, and revoking a token anywhere withdraws the
 * grant for the whole Cloud project. When that happens every tool here fails
 * with `invalid_grant`. This opens the consent flow and writes a fresh token.
 *
 *   node tools/reauth.mjs
 */
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorize } from './lib/auth.mjs'
import { driveClient } from './lib/drive.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

// Remove the dead token first, or authorize() reuses it and fails again.
await rm(join(__dir, '.token.json'), { force: true })

const auth = await authorize()
const drive = driveClient(auth)
const { data } = await drive.files.list({ q: "'root' in parents and trashed=false", pageSize: 1, fields: 'files(id)' })
console.log(`\n  Authorized. Drive reachable (${data.files?.length ?? 0} item(s) sampled at root).\n`)
