#!/usr/bin/env bash
# Write what a bot needs to read into one markdown file. No model, no writes.
#   context.sh issue N   |   context.sh pr N [base-branch]
set -euo pipefail
kind=$1; n=$2; base=${3:-main}
strip() { sed -E 's/<!--[^>]*-->//g'; }

issue_block() {
  gh issue view "$1" --json number,title,body,labels \
    --jq '"## Issue #\(.number): \(.title)\nLabels: \([.labels[].name]|join(", "))\n\n\(.body)\n"' | strip
  echo "### Comments on #$1"
  gh api "repos/$GITHUB_REPOSITORY/issues/$1/comments" --paginate \
    --jq '.[] | select(.body | startswith("<!-- bot-digest") | not) | "- **\(.user.login)** (\(.created_at)): \(.body)"' | strip | tail -n 60
  echo
}

if [ "$kind" = issue ]; then
  issue_block "$n"
else
  gh pr view "$n" --json number,title,body,headRefName \
    --jq '"## PR #\(.number): \(.title)  (branch \(.headRefName))\n\n\(.body)\n"' | strip
  linked=$(gh pr view "$n" --json body --jq .body | grep -oiE '(closes|fixes) #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
  [ -n "$linked" ] && issue_block "$linked"
  echo "### PR conversation (newest last)"
  gh api "repos/$GITHUB_REPOSITORY/issues/$n/comments" --paginate \
    --jq '.[] | "- **\(.user.login)** (\(.created_at)): \(.body)"' | sed -E 's/<!-- (bot-[a-z]+)[^>]*-->/[\1]/g' | tail -n 80
  echo
  echo "### Inline review comments"
  gh api "repos/$GITHUB_REPOSITORY/pulls/$n/comments" --paginate \
    --jq '.[] | "- **\(.user.login)** on `\(.path):\(.line // .original_line)`: \(.body)"' | strip | tail -n 60
  echo
  echo "### Files changed vs $base"
  git diff --stat "origin/$base...HEAD" | tail -n 40
fi
