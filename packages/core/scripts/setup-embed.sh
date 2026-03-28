#!/bin/bash
# =============================================================================
# setup-embed.sh — Minimal pod setup for embedding (Node.js + pnpm only)
#
# Unlike setup.sh (which installs Python, faster-whisper, Marker for
# transcription), this script only installs what's needed to run
# media:embed with local ONNX models (jina-local or nomic-local).
#
# Duration: ~30-60s (vs ~5 min for setup.sh)
# =============================================================================
set -euo pipefail
START_TIME=$SECONDS

echo "============================================"
echo "  🔮 tcc — Embed Pod Setup"
echo "============================================"

cd /root

# Show GPU info
echo ""
echo "📋 GPU info:"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "   (no GPU detected)"

# 0. SSL certificates (RunPod images sometimes miss these)
echo ""
echo "📦 [0/2] SSL certificates..."
apt-get update -qq 2>&1 | tail -1
apt-get install -y ca-certificates 2>&1 | tail -1
update-ca-certificates --fresh 2>&1 | tail -1
echo "   ✅ Done"

# 1. Node.js 22 + pnpm
echo ""
echo "📦 [1/2] Node.js 22..."
if command -v node &>/dev/null && [[ "$(node -v)" == v22* ]]; then
  echo "   ✅ Already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>&1 | tail -3
  apt-get install -y nodejs 2>&1 | tail -1
  echo "   ✅ Node.js $(node -v)"
fi

echo ""
echo "📦 [2/2] pnpm..."
if command -v pnpm &>/dev/null; then
  echo "   ✅ Already installed: $(pnpm -v)"
else
  npm install -g pnpm 2>&1 | tail -1
  echo "   ✅ pnpm $(pnpm -v)"
fi

ELAPSED=$((SECONDS - START_TIME))
echo ""
echo "============================================"
echo "  ✅ Embed pod setup complete!"
echo "============================================"
echo "  Node: $(node -v)"
echo "  pnpm: $(pnpm -v)"
echo "  ⏱️  Installed in ${ELAPSED}s"
echo ""
