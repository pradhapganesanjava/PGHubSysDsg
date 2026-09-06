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
         "$DEST/tools/hooks"

cp "$SRC"/index.html "$SRC"/module.html "$SRC"/dev.py "$SRC"/README.md \
   "$SRC"/.gitignore "$SRC"/.nojekyll                   "$DEST/"
cp "$SRC"/app/*.js                                      "$DEST/app/"
cp "$SRC"/vendor/mermaid.min.js                         "$DEST/vendor/"
cp "$SRC"/tools/*.mjs "$SRC"/tools/*.py "$SRC"/tools/*.sh \
   "$SRC"/tools/package.json                            "$DEST/tools/"
cp "$SRC"/tools/lib/*.mjs                               "$DEST/tools/lib/"
cp "$SRC"/tools/test/*.mjs                              "$DEST/tools/test/"
cp "$SRC"/tools/hooks/*                                 "$DEST/tools/hooks/"

# The GitHub Actions workflow is deliberately NOT copied. Pushing a file under
# .github/workflows/ needs the `workflow` OAuth scope, which the account that
# owns the public repo does not have, so including it makes every push fail.
# The site needs no build anyway — Pages serves the branch directly — and the
# safety check that workflow ran now runs earlier, as a pre-push hook.
#
# To restore CI: grant the scope (`gh auth refresh -s workflow`), then
#   mkdir -p "$DEST/.github/workflows"
#   cp "$SRC"/.github/workflows/deploy.yml "$DEST/.github/workflows/"

echo "  synced $SRC -> $DEST"
( cd "$DEST" && git add -A >/dev/null 2>&1 || true
  bash tools/check-public-safe.sh )
