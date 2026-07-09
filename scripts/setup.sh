#!/usr/bin/env bash
# =============================================================================
# One-command provisioning for the Agent Harness
# =============================================================================
# Prerequisites:
#   1. CLOUDFLARE_API_TOKEN — from dashboard → My Profile → API Tokens
#   2. CLOUDFLARE_ACCOUNT_ID — from dashboard sidebar
#   3. LLM_API_KEY — your Anthropic/OpenAI API key
#   4. DASHBOARD_TOKEN — a secret token for dashboard auth
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... LLM_API_KEY=... DASHBOARD_TOKEN=... ./scripts/setup.sh
# =============================================================================

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN first (dashboard → My Profile → API Tokens)}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID first (dashboard sidebar)}"
: "${LLM_API_KEY:?Set LLM_API_KEY first (your Anthropic or OpenAI API key)}"
: "${DASHBOARD_TOKEN:?Set DASHBOARD_TOKEN first (any strong secret for dashboard auth)}"

echo "📦 Installing dependencies..."
npm install

echo "🔐 Setting secrets..."
echo "$LLM_API_KEY" | npx wrangler secret put LLM_API_KEY
echo "$DASHBOARD_TOKEN" | npx wrangler secret put DASHBOARD_TOKEN

echo "🚀 Deploying..."
npx wrangler deploy

echo ""
echo "============================================="
echo "✅ Deployed successfully!"
echo "============================================="
echo ""
echo "The cron watchdog starts the agent automatically within 2 minutes."
echo ""
echo "Useful commands:"
echo "  npx wrangler tail              # live logs"
echo "  npx wrangler tail --status error  # errors only"
echo "  npx wrangler deployments list  # deploy history"
echo ""
echo "Dashboard: https://agent-harness.<your-subdomain>.workers.dev"
echo "Token: use the DASHBOARD_TOKEN you just set"
