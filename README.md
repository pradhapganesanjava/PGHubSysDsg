# System Design Hub

A study hub for system design — terms, Q&A, topics, worked designs and a document
library across thirteen modules.

**This repository contains only the application.** Every piece of content — every
term, answer, note, document and image — lives in a private Google Drive folder
and is fetched in your browser with your own Google token. Nothing studied here
is stored in, or served from, this repository.

---

## How it works

```
    Anyone can read this repo              Only the owner can read this
   ┌───────────────────────────┐          ┌────────────────────────────┐
   │  index.html   module.html │          │   Google Drive             │
   │  app/*.js     vendor/     │  OAuth   │     SysDsgHub/             │
   │                           │ ───────► │       hub.json             │
   │  ~3k lines of app code,   │  token   │       hub-index.json       │
   │  zero content             │          │       01-foundations/      │
   └───────────────────────────┘          │         terms.json …       │
        GitHub Pages (public)             │         docs/  images/     │
                                          │     SysDsgHub Manifest 📊  │
                                          └────────────────────────────┘
```

The site is static. There is no server, no database and no API key: the browser
talks to Drive directly, authenticated as whoever signed in. A visitor who is
not the folder's owner sees a sign-in screen and nothing else, because Drive
will not serve them the files.

### The one interesting trick

The module app is ~3,000 lines that were written against a local Python server,
talking to it through fourteen `fetch()` calls on relative paths — `/terms`,
`/qa`, `/docs`, `/upload` and so on. None of that code was rewritten. Instead
`app/store.js` patches `window.fetch`, answers exactly those paths out of Drive,
and passes everything else through. The application cannot tell the difference.

Two consequences worth knowing:

- **Reads are cached** for the session. A Drive round trip is ~200 ms where
  localhost was ~1 ms.
- **Writes are debounced** (~1 s) and flushed on page hide. The app saves a whole
  file per edited item, so saving on every keystroke would re-upload the same
  100 KB repeatedly. A chip in the corner shows when a save is pending, and
  `Cmd/Ctrl-S` forces one.

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page — module cards, cross-module tree, search, practice |
| `module.html` | The module app. One page for all thirteen; `?m=01-foundations` selects |
| `app/` | The Drive layer: auth, Drive REST, the fetch store, media, sign-in gate |
| `vendor/` | Third-party libraries (mermaid) |
| `tools/` | Migration and maintenance. Never deployed |
| `dev.py` | Static file server for local development |

Thirteen near-identical copies of the module app used to exist, differing only in
their title, emoji and one-line subtitle. They are now one page that reads its
identity from `hub.json` at runtime.

---

## Two checkouts

| Checkout | Visibility | Holds |
|---|---|---|
| `SysDsgHubPublic` | public | this code — the published site |
| `SysdsgHubHost` | private | the original content, kept as an archive |

They have separate git histories on purpose: the private repo's history contains
the content, and GitHub can keep unreachable objects retrievable by commit SHA
long after a force-push, so rewriting it would not have been airtight.

Day-to-day the content is edited in the app and saved to Drive, and code is
edited here. The migration tools are the exception — they read `hub.json` and
the per-module folders off disk, so they only run in the private checkout.
`tools/sync-public.sh` copies code from there to here.

---

## Running it locally

```bash
python3 dev.py            # http://localhost:5173/
```

Port 5173 is the default because it is almost certainly already registered as an
authorized JavaScript origin on the OAuth client. Serving from an unregistered
origin makes Google reject sign-in with `origin_mismatch`; add the origin under
**APIs & Services → Credentials → your Web client** if you use another port.

---

## Migrating content into Drive

Only needed once, or when adding content from outside the app. Requires
`tools/credentials.json` (a Desktop OAuth client from the same Cloud project as
the web client) — both are gitignored.

```bash
python3 tools/build-docs-index.py     # bake the /docs and hub payloads
node    tools/migrate.mjs --dry-run   # report, write nothing
node    tools/migrate.mjs             # upload
```

The migration is idempotent and resumable: it keys everything on
(parent folder, name), skips files whose checksum already matches, retries
transient Google errors with backoff, and checkpoints to
`tools/.migration-state.json`. Re-running after an interruption picks up where it
stopped.

`build-docs-index.py` deliberately imports the old `server.py` and `serve_hub.py`
and calls their own functions, so the baked search index is identical to what
those servers produced rather than a reimplementation that could drift.

---

## Adding a document

Drop the file into the module's `docs/` folder in Drive. The app lists that
folder and folds in anything the baked index doesn't know about, so it appears
in the sidebar on the next load — no migration, no checkout, no deploy.

A new document is browsable and readable immediately. The one thing it lacks is
its extracted **search** text, which `build-docs-index.py` produces by walking
the HTML; it becomes searchable after the next migration. New markdown files are
read on load so they render, and their title comes from the first `# heading`.

---

## Before making the repository public

```bash
bash tools/check-public-safe.sh
```

It inspects what git actually tracks — not just what `.gitignore` covers, since
that does nothing for files committed before the rule existed — and fails on
credentials, per-module data stores, document and image libraries, baked
indexes, or a key pasted into source. The same check gates every deploy in
`.github/workflows/deploy.yml`, so a mistake blocks the publish rather than
shipping.

---

## Access

`app/config.js` holds a SHA-256 of the owner's Google address and shows a clear
message to anyone else. **This is a courtesy, not a security boundary** — anyone
can edit client-side JavaScript. What actually keeps the content private is the
Drive folder's ACL: a browser signed in as someone else simply cannot read the
files. Add an address with:

```bash
node tools/hash-email.mjs someone@example.com
```

The OAuth client id in `config.js` is public by design; Google treats it as an
identifier, not a secret, and it is inert without a user consenting in a browser.

### If saving fails with 403

Reads work but writes do not. Drive grants `drive.file` access per *Cloud
project*, and the migration tool and the web app share project `pg-hub-tech`, so
this should not happen — but if it does, swap the two Drive scopes in
`app/config.js` for the single `https://www.googleapis.com/auth/drive`, add it on
the OAuth consent screen, and sign in again.
