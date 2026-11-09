#!/usr/bin/env bash
# Builds a single self-extracting Windows exe that runs the OpenCut web app
# locally: double-click it and it starts the Next.js server on loopback and
# opens the browser. See desktop/launcher.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

SHA="$(git rev-parse --short HEAD)"
export NEXT_TELEMETRY_DISABLED=1

echo "==> bun install"
# Hoisted layout: next's standalone output can't resolve deps out of bun's
# isolated .bun store, so a standalone build off the default linker breaks.
bun install --frozen-lockfile --linker=hoisted

echo "==> next build (standalone)"
# Env demanded by src/lib/env/web.ts at import time during prerendering.
# Placeholder values; offline-only features never call them for real.
export NEXT_PUBLIC_MARBLE_API_URL="https://api.marblecms.com"
export DATABASE_URL="postgres://placeholder:placeholder@127.0.0.1:5432/placeholder"
export BETTER_AUTH_SECRET="placeholder-not-a-real-secret"
export UPSTASH_REDIS_REST_URL="https://placeholder.upstash.io"
export UPSTASH_REDIS_REST_TOKEN="placeholder"
export MARBLE_WORKSPACE_KEY="placeholder"
export FREESOUND_CLIENT_ID="placeholder"
export FREESOUND_API_KEY="placeholder"
(cd apps/web && bun run build)

STANDALONE=apps/web/.next/standalone
echo "==> attaching static assets to the standalone output"
# `next build` leaves .next/static and public/ out of standalone on purpose;
# the standalone server expects them at apps/web/.next/static and public/.
mkdir -p "$STANDALONE/apps/web/.next"
cp -r apps/web/.next/static "$STANDALONE/apps/web/.next/static"
cp -r apps/web/public "$STANDALONE/apps/web/public"
# next's standalone tracer misses runtime require()s: next's own require-hook
# needs styled-jsx at server start, so copy it in explicitly.
rm -rf "$STANDALONE/node_modules/styled-jsx"
cp -r node_modules/styled-jsx "$STANDALONE/node_modules/styled-jsx"

echo "==> packing standalone tree"
mkdir -p dist
bun run desktop/pack.ts "$STANDALONE" dist/app.pack

echo "==> staging the bun runtime"
# The compiled launcher cannot require() from disk-loaded files, so the
# server runs in a child `bun` process extracted alongside the app.
cp "$(command -v bun)" dist/bun-runtime.exe

echo "==> bun compile"
bun build --compile \
	--define "BUILD_SHA=\"$SHA\"" \
	--outfile "dist/opencut-desktop-windows-x64.exe" \
	desktop/launcher.ts

rm dist/app.pack dist/bun-runtime.exe
ls -lh dist/opencut-desktop-windows-x64.exe

ls -lh dist/opencut-desktop-windows-x64.exe
