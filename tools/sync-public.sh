#!/usr/bin/env bash
# Copy the code — and only the code — into the public repository checkout.
#
# Two checkouts exist on purpose:
#
#   SysdsgHubHost      private archive. Holds the original content, and is the
#                      only place the migration tools can run, since they read
#                      hub.json and the per-module folders from disk.
#   SysDsgHubPublic    what gets published. Code only, its own git history, so
#                      no object from the private repo can ever be reachable.
#
# Files are enumerated explicitly rather than copied-then-pruned, so nothing
# private can arrive by accident. Run the safety check afterwards regardless.
set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
DEST=${1:-"$(dirname "$SRC")/SysDsgHubPublic"}

[ -d "$DEST" ] || { echo "  No such directory: $DEST" >&2; exit 1; }

mkdir -p "$DEST/app" "$DEST/vendor" "$DEST/tools/lib" "$DEST/tools/test" \
         "$DEST/.github/workflows"

cp "$SRC"/index.html "$SRC"/module.html "$SRC"/dev.py "$SRC"/README.md \
   "$SRC"/.gitignore "$SRC"/.nojekyll                   "$DEST/"
cp "$SRC"/app/*.js                                      "$DEST/app/"
cp "$SRC"/vendor/mermaid.min.js                         "$DEST/vendor/"
cp "$SRC"/tools/*.mjs "$SRC"/tools/*.py "$SRC"/tools/*.sh \
   "$SRC"/tools/package.json                            "$DEST/tools/"
cp "$SRC"/tools/lib/*.mjs                               "$DEST/tools/lib/"
cp "$SRC"/tools/test/*.mjs                              "$DEST/tools/test/"
cp "$SRC"/.github/workflows/deploy.yml                  "$DEST/.github/workflows/"

echo "  synced $SRC -> $DEST"
( cd "$DEST" && git add -A >/dev/null 2>&1 || true
  bash tools/check-public-safe.sh )
