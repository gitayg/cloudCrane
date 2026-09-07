#!/usr/bin/env bash
#
# install-hooks.sh — installs the local git hooks for AppCrane.
#
# Run once after `git clone` (or any time the hook script changes):
#   bash scripts/install-hooks.sh
#
# What it installs, as a pre-commit hook:
#   - scripts/check-role-patterns.sh    --strict
#   - scripts/check-no-shadow-js.sh     --strict
#   - scripts/check-test-portability.sh --strict
#   - scripts/check-route-authz.mjs     --strict
#
# THIS LIST MUST MATCH .github/workflows/role-check.yml. It did not once:
# check-route-authz ran only in CI, so a route that took an app identifier
# without a per-app authorization check committed cleanly and turned CI red
# after the push (v2.60.0). A check that exists only in CI is discovered at
# the least convenient moment, and this repo has already had CI sit red for
# five releases without anyone noticing.
#
# `npm test` is deliberately NOT here. CI runs it; at ~72s it would make every
# commit painful, and the hook's job is fast feedback rather than full proof.
#
# All scripts exist in the repo and are versioned. The hook exits non-zero if
# any watchdog fires, blocking the commit (use `--no-verify` to override).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOOK_DIR=".git/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"

if [ ! -d "$HOOK_DIR" ]; then
  echo "[install-hooks] $HOOK_DIR not found. Are you in a git checkout?"
  exit 1
fi

cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh — re-run that script if the watchdog
# set changes. Override individual commits with `git commit --no-verify`.
set -e
bash scripts/check-role-patterns.sh --strict
bash scripts/check-no-shadow-js.sh --strict
bash scripts/check-test-portability.sh --strict
node scripts/check-route-authz.mjs --strict
HOOK

chmod +x "$HOOK_FILE"
echo "[install-hooks] Installed $HOOK_FILE"
echo "[install-hooks] Test it now with: bash $HOOK_FILE"
