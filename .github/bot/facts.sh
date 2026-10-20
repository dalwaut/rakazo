#!/usr/bin/env bash
# Repo-owned: deterministic facts the scout reads. pnpm monorepo.
set -uo pipefail
[ -n "${BOT_ENV_FILE:-}" ] && [ -f "$BOT_ENV_FILE" ] && { set -a; . "$BOT_ENV_FILE"; set +a; }
echo "## HEAD"; git log -1 --format='%h %s'
echo; echo "## pnpm outdated (top-level, major behind only)"
pnpm outdated --format json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d||"[]");for(const v of o){const a=String(v.current||"").split(".")[0],b=String(v.latest||"").split(".")[0];if(a&&b&&a!==b)console.log(`${v.name} ${v.current} -> ${v.latest}`)}}catch{}})' 2>/dev/null
echo; echo "## TODO/FIXME in apps and packages"
grep -rnE "TODO|FIXME" apps packages --include=*.ts --include=*.tsx 2>/dev/null | head -20
