#!/bin/sh
# Parse-check every browser module. `node --check` only treats a file as ESM
# when it ends in .mjs, so each is linked to a temp .mjs first.
set -e
tmp=$(mktemp -d)
status=0
for f in "$@"; do
  cp "$f" "$tmp/$(basename "$f" .js).mjs"
  if node --check "$tmp/$(basename "$f" .js).mjs" 2>"$tmp/err"; then
    printf '  ok    %s\n' "$f"
  else
    printf '  FAIL  %s\n' "$f"; sed 's/^/        /' "$tmp/err"; status=1
  fi
done
rm -rf "$tmp"
exit $status
