// OAuth for the migration tools.
//
// Reuses the Desktop OAuth client shared with _PGHubTech/scripts — same Cloud
// project (pg-hub-tech) as the browser app's Web client, which matters: Drive
// grants `drive.file` access per *project*, so files this tool creates stay
// reachable from the portal without widening anyone's consent.
//
// `drive.file` is enough here because migration only ever CREATES files, and an
// app always retains access to what it created. We accept either that or the
// broader `drive`, so an already-authorized token is reused as-is and nobody
// has to re-consent just to run a migration.
import { readFile, writeFile } from 'node:fs/promises'
import { createServer }        from 'node:http'
import { dirname, join }       from 'node:path'
import { fileURLToPath }       from 'node:url'
import { google }              from 'googleapis'

const __dir      = dirname(fileURLToPath(import.meta.url))
const CREDS_PATH = join(__dir, '..', 'credentials.json')
const TOKEN_PATH = join(__dir, '..', '.token.json')

// Requested on a FRESH authorization. Existing narrower tokens are still
// accepted (see hasAllScopes) so a re-consent is never forced needlessly.
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
]

const DRIVE_OK = [
  'https://www.googleapis.com/auth/drive',        // full — superset
  'https://www.googleapis.com/auth/drive.file',   // per-file — enough to create
]

function hasAllScopes(granted) {
  const have = new Set((granted ?? '').split(/\s+/).filter(Boolean))
  return have.has('https://www.googleapis.com/auth/spreadsheets')
      && DRIVE_OK.some(s => have.has(s))
}

export async function authorize() {
  let creds
  try {
    creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'))
  } catch {
    throw new Error(
      'Missing tools/credentials.json — copy a Desktop OAuth client JSON there ' +
      '(Drive + Sheets APIs enabled on the project).'
    )
  }
  const c = creds.installed ?? creds.web
  if (!c) throw new Error('credentials.json is not a Desktop/Web OAuth client file')

  const client = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost:4571/')

  try {
    const token = JSON.parse(await readFile(TOKEN_PATH, 'utf8'))
    if (hasAllScopes(token.scope)) {
      client.setCredentials(token)
      // persist refreshed access tokens without dropping the refresh_token
      client.on('tokens', t => {
        writeFile(TOKEN_PATH, JSON.stringify({ ...token, ...t }, null, 2)).catch(() => {})
      })
      return client
    }
    console.log('  Saved token lacks the full Drive scope — re-authorizing once…')
  } catch { /* no token yet */ }

  return interactiveAuth(client)
}

function interactiveAuth(client) {
  // prompt:'consent' guarantees a refresh_token even if the app is already authorized
  const url = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: SCOPES,
  })
  console.log('\n  Authorize this tool in your browser (sign in as the Drive owner):\n')
  console.log(`  ${url}\n`)

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:4571').searchParams.get('code')
      if (!code) { res.writeHead(400).end('No code'); return }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>')
      server.close()
      try {
        const { tokens } = await client.getToken(code)
        client.setCredentials(tokens)
        await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2))
        console.log('  Token saved to tools/.token.json (gitignored).\n')
        resolve(client)
      } catch (e) { reject(e) }
    })
    server.listen(4571)
    server.on('error', reject)
  })
}
