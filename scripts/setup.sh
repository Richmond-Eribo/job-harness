#!/usr/bin/env bash
# =============================================================================
# One-command provisioning for the Agent Harness (v1, free tier)
# =============================================================================
# What it does:
#   1. Loads secrets from .dev.vars if present (so you don't retype them)
#   2. npm install
#   3. wrangler deploy   (Worker must exist BEFORE we can attach secrets)
#   4. wrangler secret put LLM_API_KEY / DASHBOARD_TOKEN
#
# Required environment variables (the two Cloudflare creds — NOT in .dev.vars):
#   CLOUDFLARE_API_TOKEN   — dashboard → My Profile → API Tokens ("Edit Workers")
#   CLOUDFLARE_ACCOUNT_ID  — dashboard sidebar
#
# Optional (auto-loaded from .dev.vars if present, else required inline):
#   LLM_API_KEY       — your LLM provider's API key (Z.ai/GLM, OpenAI, Anthropic…)
#   DASHBOARD_TOKEN   — any strong secret string for dashboard auth
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/setup.sh
#   (LLM_API_KEY + DASHBOARD_TOKEN will be read from .dev.vars automatically)
# =============================================================================

set -euo pipefail

# --- 1. Auto-load .dev.vars if it exists (so local dev secrets carry over) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_VARS="$SCRIPT_DIR/../.dev.vars"
if [[ -f "$DEV_VARS" ]]; then
  echo "📑 Loading secrets from .dev.vars"
  # shellcheck disable=SC1090
  set -a
  source "$DEV_VARS"
  set +a
fi

# --- 2. Validate the four required values are now present ---

: "${LLM_API_KEY:?Set LLM_API_KEY first — either in .dev.vars or as an env var}"
: "${DASHBOARD_TOKEN:?Set DASHBOARD_TOKEN first — either in .dev.vars or as an env var}"

# --- 3. Install deps ---
echo "📦 Installing dependencies..."
npm install

# --- 4. Deploy FIRST (wrangler secret put requires the Worker to exist) ---
echo "🚀 Deploying Worker..."
npx wrangler deploy

# --- 5. Now attach secrets to the deployed Worker ---
echo "🔐 Setting secrets on the deployed Worker..."
printf "%s" "$LLM_API_KEY"     | npx wrangler secret put LLM_API_KEY
printf "%s" "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN

echo ""
echo "============================================="
echo "✅ Deployed + secrets attached!"
echo "============================================="
echo ""
echo "Model identity (provider/model/url) and generation params live in"
echo "src/llm-config.json — already bundled into the deploy. Edit that file"
echo "and re-run this script to change models."
echo ""
echo "The cron watchdog fires every 2 min and starts a run when a schedule"
echo "(added via the dashboard) is due."
echo ""
echo "Useful commands:"
echo "  npx wrangler tail                    # live logs"
echo "  npx wrangler tail --status error     # errors only"
echo "  npx wrangler deployments list        # deploy history"
echo "  npx wrangler secret list             # verify secrets are set"
echo ""
echo "Dashboard: https://agent-harness.<your-subdomain>.workers.dev"
echo "Auth token: the DASHBOARD_TOKEN value (now: $DASHBOARD_TOKEN)"
