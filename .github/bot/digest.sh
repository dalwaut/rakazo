#!/usr/bin/env bash
# Build the "Decisions needed" digest. Deterministic: no model.
# Prints the issue body on stdout and "COUNT=<n>" on fd 3.
set -euo pipefail
R=$GITHUB_REPOSITORY
since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)

lastq() {  # latest bot question on an issue/PR, one line
  gh api "repos/$R/issues/$1/comments" --paginate --jq '.[] | select(.body | test("<!-- bot-question")) | .body' \
    | tail -n 40 | sed -E 's/<!--[^>]*-->//g; s/@[A-Za-z0-9-]+ //g' | tr '\n' ' ' | sed -E 's/ +/ /g' | tail -c 280
}

q=$(gh issue list --repo "$R" --state open --label needs-human --json number,title,url --jq '.[] | "\(.number)\t\(.title)\t\(.url)"' 2>/dev/null || true)
p=$(gh pr list --repo "$R" --state open --label needs-human --json number,title,url --jq '.[] | "\(.number)\t\(.title)\t\(.url)"' || true)
ready=$(gh pr list --repo "$R" --state open --label ready-for-merge --json number,title,url --jq '.[] | "- [ ] [#\(.number) \(.title)](\(.url))"')
props=$(gh issue list --repo "$R" --state open --label scout --json number,title,url,labels \
  --jq '.[] | select([.labels[].name] | (index("agent:go") or index("needs-human")) | not) | "- [#\(.number) \(.title)](\(.url))"')
# a failure counts only while it is the latest finished run of that workflow (a later success clears it)
fails=$(gh run list --repo "$R" --limit 100 --json workflowName,createdAt,url,displayTitle,status,conclusion \
  --jq "[.[] | select(.workflowName | startswith(\"bot-\")) | select(.status == \"completed\") | select(.conclusion != \"skipped\" and .conclusion != \"cancelled\" and .conclusion != \"action_required\")]
        | group_by(.workflowName) | map(max_by(.createdAt))
        | .[] | select(.conclusion == \"failure\") | select(.createdAt > \"$since\") | \"- [\(.workflowName): \(.displayTitle)](\(.url))\"")

questions=""
while IFS=$'\t' read -r n t u; do
  [ -n "$n" ] || continue
  questions+="- [#$n $t]($u): $(lastq "$n")"$'\n'
done <<<"$(printf '%s\n%s\n' "$q" "$p")"

count=0
for block in "$questions" "$ready" "$props" "$fails"; do
  [ -n "$block" ] && count=$((count + $(grep -c '^- ' <<<"$block")))
done
echo "COUNT=$count" >&3

echo "<!-- bot-digest -->"
echo "Updated $(date -u '+%Y-%m-%d %H:%M UTC') by bot-digest. Only things that need you are listed."
echo
echo "### Questions for you"; echo "${questions:-_none_}"; echo
echo "### Ready to merge"; echo "${ready:-_none_}"; echo
echo "### Proposals waiting for \`agent:go\` (or close)"; echo "${props:-_none_}"; echo
echo "### Bot runs that failed (24 h)"; echo "${fails:-_none_}"
