#!/usr/bin/env bash
# Point git at tools/hooks so the pre-push safety check runs for everyone who
# clones this. Hooks cannot be committed into .git/hooks directly, but
# core.hooksPath can be repointed at a tracked directory.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
chmod +x tools/hooks/*
git config core.hooksPath tools/hooks
echo "  hooks installed — tools/check-public-safe.sh now runs before every push"
