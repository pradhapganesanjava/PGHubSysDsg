#!/usr/bin/env bash
# Refuse to publish anything that belongs in Drive, not in a public repo.
#
# .gitignore is the first line of defence, but it only helps for files nobody
# force-added and it does nothing about a file committed before the rule
# existed. This inspects what is ACTUALLY tracked by git, so it catches those.
# It runs in CI before every deploy, and is worth running by hand before a push:
#
#     bash tools/check-public-safe.sh
#
# Exit 0 = safe to publish.
set -uo pipefail

fail=0
note() { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }

# Everything git is tracking. Falls back to a filesystem walk outside a repo.
if git rev-parse --git-dir >/dev/null 2>&1; then
  tracked=$(git ls-files)
else
  tracked=$(find . -type f -not -path './.git/*' | sed 's|^\./||')
fi

check_none() {                      # check_none <description> <grep-ERE>
  local desc=$1 pattern=$2 hits
  hits=$(printf '%s\n' "$tracked" | grep -E "$pattern" || true)
  if [ -n "$hits" ]; then
    note "$desc"
    printf '      %s\n' $hits | head -20
    local n; n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
    [ "$n" -gt 20 ] && printf '      … and %s more\n' "$((n - 20))"
  else
    ok "$desc"
  fi
}

echo
echo "  Checking the repository is safe to publish"
echo

check_none "no OAuth credentials or tokens"      '(^|/)(credentials\.json|\.token\.json|client_secret.*\.json)$'
check_none "no environment files"                '(^|/)\.env($|\.)'
check_none "no per-module data stores"           '(^|/)(terms|qa|topics|notes|docs)\.json$'
check_none "no baked content indexes"            '(^|/)(docs-index|hub-index|assets-map)\.json$'
check_none "no hub manifest"                     '(^|/)hub\.json$'
check_none "no document or image libraries"      '(^|/)(docs|images)/'
check_none "no legacy per-module apps"           '^(0[0-9]|1[0-2])-[a-z]+/|^interview-prep/|^_templates/'
check_none "no migration state"                  '(^|/)\.migration-state\.json$|^tools/out/'

# Content of tracked files: catch a key pasted into source.
# Anchored to a real assignment: prose *about* OAuth (this repo is full of it)
# should not trip the check, only an actual key pasted into a file.
secret_re='(AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(client_secret|refresh_token|private_key)"[[:space:]]*:[[:space:]]*"[^"]+")'
hits=$(printf '%s\n' "$tracked" | while read -r f; do
         [ -f "$f" ] && grep -lE "$secret_re" -- "$f" 2>/dev/null
       done)
if [ -n "$hits" ]; then
  note "no secrets embedded in tracked files"
  printf '      %s\n' $hits
else
  ok "no secrets embedded in tracked files"
fi

echo
if [ "$fail" -ne 0 ]; then
  cat <<'MSG'
  BLOCKED — the items above are private and must not be published.

  If one is tracked by mistake:
      git rm --cached -r <path>        # keeps your local copy
      git commit -m "Remove private content from the repo"

  Content belongs in Google Drive; put it there with tools/migrate.mjs.
MSG
  exit 1
fi
echo "  Safe to publish."
echo
