#!/usr/bin/env bash
# =============================================================================
# One-command provisioning for the Agent Harness API worker (v1, free tier)
# =============================================================================
# This provisions ONLY the backend (the Hono REST API worker). The frontend is
# a separate TanStack Start app — deploy it afterwards with `npm run deploy:web`
# (see README → Deploy). The two live on independent Cloudflare origins and the
# browser calls the API cross-origin (CORS + SameSite=None session cookie).
#
# What it does:
#   1. Loads secrets from packages/hono-worker/.dev.vars if present
#   2. npm install (root workspaces)
#   3. wrangler deploy (the API worker)  — must exist BEFORE attaching secrets
#   4. wrangler secret put for each required secret
#
# Required environment variables (Cloudflare creds — NOT in .dev.vars):
#   CLOUDFLARE_API_TOKEN   — dashboard → My Profile → API Tokens ("Edit Workers")
#   CLOUDFLARE_ACCOUNT_ID  — dashboard sidebar
#
# Secrets (auto-loaded from packages/hono-worker/.dev.vars if present):
#   LLM_API_KEY     — your LLM provider's API key
#   AUTH_SECRET     — session-cookie signing key (`openssl rand -hex 32`)
#   RESEND_API_KEY  — Resend API key for OTP emails (https://resend.com/api-keys)
#   MAIL_FROM       — a Resend-verified sender address
#   BETTER_AUTH_URL — the public API origin (e.g. https://agent-harness.x.workers.dev)
#   FRONTEND_URL    — the public FRONTEND origin (CORS allowlist + trusted origin)
#
# Usage:
#   cd packages/hono-worker && cp .dev.vars.example .dev.vars  # fill it in
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/setup.sh
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT_DIR/packages/hono-worker"
DEV_VARS="$WORKER_DIR/.dev.vars"

# --- 1. Auto-load .dev.vars if it exists ---
if [[ -f "$DEV_VARS" ]]; then
  echo "📑 Loading secrets from packages/hono-worker/.dev.vars"
  set -a
  # shellcheck disable=SC1090
  source "$DEV_VARS"
  set +a
fi

# --- 2. Validate required values ---
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN (dashboard → My Profile → API Tokens)}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID (dashboard sidebar)}"
: "${LLM_API_KEY:?Set LLM_API_KEY — either in .dev.vars or as an env var}"
: "${AUTH_SECRET:?Set AUTH_SECRET — generate with: openssl rand -hex 32}"

# --- 3. Install deps (root workspaces) ---
echo "📦 Installing dependencies..."
cd "$ROOT_DIR"
npm install

# --- 4. Deploy the API worker (must exist before secret put) ---
echo "🚀 Deploying the API worker..."
cd "$WORKER_DIR"
npx wrangler deploy

# --- 5. Attach secrets ---
echo "🔐 Setting secrets on the deployed API worker..."
printf "%s" "$LLM_API_KEY"  | npx wrangler secret put LLM_API_KEY
printf "%s" "$AUTH_SECRET"  | npx wrangler secret put AUTH_SECRET
[[ -n "${RESEND_API_KEY:-}" ]] && printf "%s" "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY
[[ -n "${MAIL_FROM:-}" ]]      && printf "%s" "$MAIL_FROM"      | npx wrangler secret put MAIL_FROM
[[ -n "${BETTER_AUTH_URL:-}" ]] && printf "%s" "$BETTER_AUTH_URL" | npx wrangler secret put BETTER_AUTH_URL
[[ -n "${FRONTEND_URL:-}" ]]   && printf "%s" "$FRONTEND_URL"   | npx wrangler secret put FRONTEND_URL

echo ""
echo "============================================="
echo "✅ API worker deployed + secrets attached!"
echo "============================================="
echo ""
echo "Model identity (provider/model/url) + generation params live in"
echo "packages/hono-worker/src/config/llm-config.json."
echo ""
echo "Next: deploy the FRONTEND (separate origin) with:"
echo "  VITE_API_URL=https://agent-harness.<sub>.workers.dev npm run deploy:web"
echo ""
echo "Useful:"
echo "  npm run tail                          # live API logs"
echo "  npm run dev                           # run both (API :8787 + web :5173)"
echo "  npx --workspace @agent-harness/hono-worker wrangler secret list"
