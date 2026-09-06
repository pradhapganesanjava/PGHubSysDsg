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

| Local checkout | GitHub repo | Visibility | Holds |
|---|---|---|---|
| `~/SysDsgHubPublic` | `pradhapganesanjava/PGSysdsgHub` | public | this code — the published site |
| `~/SysdsgHubHost` | `pradhapganesanjava/SysDsgHub` | private | the migration history; its working tree is now empty of content |

The local directory names and the repo names differ for historical reasons;
the table above is the mapping that matters. The site is served at
<https://pradhapganesanjava.github.io/PGSysdsgHub/> — the path is the public
repo's name, so renaming that repo moves the site.

They have separate git histories on purpose: the private repo's history contains
the content, and GitHub can keep unreachable objects retrievable by commit SHA
long after a force-push, so rewriting it would not have been airtight.

Day-to-day the content is edited in the app and saved to Drive, and code is
edited here. `tools/sync-public.sh` copies code from the private checkout to
this one.

### The migration tools need a content checkout

`migrate.mjs`, `verify.mjs`, `preflight-delete.mjs` and `build-docs-index.py`
all read `hub.json` and the per-module folders off disk. Those files were
deleted from the private checkout once everything was in Drive, so the tools
have nothing to read until the content is restored:

```bash
cd ~/SysdsgHubHost
git checkout 332dd90 -- .        # the commit before the content was removed
```

Drive is the live copy; that commit is the cold one.

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

Already done — this is here for the record, and for a re-run against restored
content (see above). Requires `tools/credentials.json`, a Desktop OAuth client
from the same Cloud project as the web client; it and the token it mints are
gitignored.

```bash
cd tools && npm install && cd ..      # googleapis; node_modules is gitignored
python3 tools/build-docs-index.py     # bake the /docs and hub payloads
node    tools/migrate.mjs --dry-run   # report, write nothing
node    tools/migrate.mjs             # upload
node    tools/verify.mjs --write      # read it all back and check it
```

The same `npm install` is what `tools/test/integration.mjs` needs — it checks
the real `drive.js` and `store.js` against the live Drive folder, so it wants
both the package and the credentials. `tools/test/run.mjs` has no dependencies
and runs anywhere.

### Search

The hub searches the full text of every term, Q&A, topic and document across
every module, against an index baked into Drive:

```bash
node tools/build-search-index.mjs --dry-run   # report size, write nothing
node tools/build-search-index.mjs             # build and upload
```

Re-run it after adding or editing content, or the new material will not be
findable from the hub.

It reads from Drive rather than disk, so unlike the other tools it needs no
content checkout. The index is *inverted* — word to the items containing it —
because the text itself is 16 MB, far too much to ship to a browser. Truncating
the text to fit was measured at 0.91 MB gzipped while covering only 79% of
items and 37% of documents; the inverted index is 0.86 MB and covers all of it.
The trade is that results carry no snippet.

The hub fetches it on the first search, not at page load.

---

`preflight-delete.mjs` is the one to run before deleting any local copy: it
walks every file individually and refuses unless each one has a Drive id that
still resolves. It is what caught two pasted note images that a count-based
check had passed.

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
indexes, or a key pasted into source.

Install it as a pre-push hook so it runs automatically:

```bash
bash tools/install-hooks.sh
```

That is deliberately a *pre*-push check rather than CI. A workflow can only tell
you about a leak once the content is already on GitHub and, in a public repo,
already fetchable by anyone watching. The hook stops the push while the content
is still only on your machine.

## Hosting

The site is static — no build, no bundler — so GitHub Pages serves the default
branch directly. There is nothing to compile and no secret to inject at build
time, because everything the page displays is fetched from Drive in the
visitor's browser using their own token.

Whatever origin it ends up served from must be added to the OAuth client's
**Authorized JavaScript origins**, or Google refuses the sign-in popup.

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
