#!/usr/bin/env bash
# Decide what the coder works on. Deterministic: no model runs here.
# In:  EVENT, ISSUE_NUM, IS_PR, INPUT_PR, DEFAULT_BRANCH, MAX_OPEN, MAX_ROUNDS, GH_TOKEN
# Out: GITHUB_OUTPUT keys mode, number, branch, issue, model, skip
set -euo pipefail
out() { echo "$1=$2" >> "$GITHUB_OUTPUT"; }
skip() { echo "skip: $1"; out skip true; exit 0; }

case "$EVENT" in
  issues) MODE=issue; NUM=$ISSUE_NUM ;;
  issue_comment) NUM=$ISSUE_NUM; [ "$IS_PR" = true ] && MODE=pr || MODE=issue ;;
  workflow_dispatch) MODE=pr; NUM=$INPUT_PR ;;
  *) skip "event $EVENT" ;;
esac

ISSUE=""
if [ "$MODE" = issue ]; then
  ISSUE=$NUM
  existing=$(gh pr list --head "bot/issue-$NUM" --state open --json number --jq '.[0].number // empty')
  if [ -n "$existing" ]; then
    MODE=pr; NUM=$existing
  else
    open=$(gh pr list --label bot --state open --json number --jq length)
    if [ "$open" -ge "$MAX_OPEN" ]; then
      gh issue comment "$ISSUE" --body "<!-- bot-note --> Waiting: $open bot PRs are already open (limit $MAX_OPEN). Re-add \`agent:go\` once one is merged or closed."
      gh issue edit "$ISSUE" --remove-label agent:go >/dev/null || true
      skip "open bot PR limit"
    fi
    BRANCH="bot/issue-$NUM"
  fi
fi

if [ "$MODE" = pr ]; then
  BRANCH=$(gh pr view "$NUM" --json headRefName --jq .headRefName)
  [ "$(gh pr view "$NUM" --json state --jq .state)" = OPEN ] || skip "PR #$NUM not open"
  rounds=$(gh api "repos/$GITHUB_REPOSITORY/issues/$NUM/comments" --paginate --jq '[.[] | select(.body | startswith("<!-- bot-review"))] | length' | awk '{s+=$1} END {print s+0}')
  if [ "$rounds" -ge "$MAX_ROUNDS" ]; then
    gh pr edit "$NUM" --add-label bot:stuck --add-label needs-human >/dev/null
    gh pr comment "$NUM" --body "<!-- bot-question --> @$GITHUB_REPOSITORY_OWNER Stuck after $rounds review rounds (limit $MAX_ROUNDS). Take it over, close it, or comment \`@claude <direction>\` to try again."
    skip "round limit"
  fi
  [ -z "$ISSUE" ] && ISSUE=$(gh pr view "$NUM" --json body --jq '.body' | grep -oiE '(closes|fixes) #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
fi

labels=$(gh issue view "${ISSUE:-$NUM}" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")
case ",$labels," in *,hard,*) MODEL=opus ;; *) MODEL=sonnet ;; esac

out mode "$MODE"; out number "$NUM"; out branch "$BRANCH"; out issue "$ISSUE"; out model "$MODEL"; out skip false
echo "mode=$MODE number=$NUM branch=$BRANCH issue=$ISSUE model=$MODEL"
