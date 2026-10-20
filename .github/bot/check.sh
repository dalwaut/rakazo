#!/usr/bin/env bash
# Repo-owned gate. The workflows run the copy from the default branch, so a
# PR cannot weaken it. Contract: last lines print CHECK_RESULT=pass|fail and
# LINT_ERRORS=<n>; exit 0 only on pass.
#   Rakazo's own CI gate is binary (biome check, turbo check): no numeric
#   lint ratchet exists upstream, so the baseline here is 0 and any lint
#   failure or typecheck failure fails the check. Full `pnpm build`
#   (needs a live Postgres + auth secrets) and the suite are NOT run here —
#   this is the spike's gate for a trivial change, not the production gate.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ -n "${BOT_ENV_FILE:-}" ] && [ -f "$BOT_ENV_FILE" ] && { set -a; . "$BOT_ENV_FILE"; set +a; }
baseline=$(cat "${BOT_BASELINE_FILE:-$here/lint-baseline}" 2>/dev/null || echo 0)

lint_log=$(mktemp)
pnpm lint >"$lint_log" 2>&1
lint_rc=$?
errors=0
[ "$lint_rc" -ne 0 ] && errors=1
echo "lint: rc=$lint_rc (baseline $baseline errors)"
[ "$lint_rc" -ne 0 ] && tail -n 40 "$lint_log"

type_log=$(mktemp)
if pnpm check >"$type_log" 2>&1; then typecheck=pass; else typecheck=fail; fi
echo "typecheck: $typecheck"
[ "$typecheck" = fail ] && tail -n 40 "$type_log"

result=pass
[ "$lint_rc" -ne 0 ] && [ "$errors" -gt "$baseline" ] && result=fail
[ "$typecheck" = fail ] && result=fail
echo "LINT_ERRORS=$errors"
echo "CHECK_RESULT=$result"
[ "$result" = pass ]
