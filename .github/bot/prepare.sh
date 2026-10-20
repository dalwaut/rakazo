#!/usr/bin/env bash
# Repo-owned: install what check.sh needs. pnpm monorepo, Node 22.
set -euo pipefail
corepack enable
pnpm install --frozen-lockfile --prefer-offline
