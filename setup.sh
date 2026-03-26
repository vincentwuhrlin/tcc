#!/bin/bash
# =============================================================================
# setup.sh — Pod setup (GPU tools only, download is done locally)
# =============================================================================
set -euo pipefail
START_TIME=$SECONDS

PIP="pip install --break-system-packages"

echo "============================================"
echo "  🔧 media2kb — Pod Setup"
echo "============================================"

cd /root

# Show pre-installed versions
echo ""
echo "📋 Image info:"
echo "   Python: $(python3 --version)"
echo "   Torch:  $(python3 -c 'import torch; print(torch.__version__)' 2>/dev/null || echo 'none')"
echo "   CUDA:   $(python3 -c 'import torch; print(torch.version.cuda)' 2>/dev/null || echo 'none')"

# 0. SSL certificates
echo ""
echo "📦 [0/3] SSL certificates..."
apt-get update -qq 2>&1 | tail -1
apt-get install -y ca-certificates 2>&1 | tail -1
update-ca-certificates --fresh 2>&1 | tail -1
echo "   ✅ Done"

# 1. System
echo ""
echo "📦 [1/3] System packages..."
apt-get install -y ffmpeg curl wget git 2>&1 | tail -3
echo "   ✅ Done"

# 2. faster-whisper
echo ""
echo "📦 [2/3] faster-whisper..."
$PIP --upgrade pip 2>&1 | tail -1
$PIP faster-whisper --no-deps 2>&1 | tail -3
$PIP ctranslate2 av tokenizers huggingface-hub 2>&1 | tail -3
echo "   ✅ faster-whisper installed"

# 3. Marker PDF — install without touching torch/torchvision/torchaudio
echo ""
echo "📦 [3/3] Marker PDF..."

# Step A: install marker and deps, but exclude torch family
$PIP marker-pdf --no-deps 2>&1 | tail -3
$PIP surya-ocr --no-deps 2>&1 | tail -3

# Step B: install all other deps (not torch)
$PIP pdftext ftfy beautifulsoup4 markdownify rapidfuzz \
     scikit-learn regex opencv-python-headless \
     pydantic pydantic-settings python-dotenv \
     google-genai openai anthropic \
     filetype click markdown2 \
     --ignore-installed blinker 2>&1 | tail -5

# Step C: install compatible transformers (marker needs <5)
$PIP "transformers>=4.45.2,<5.0.0" 2>&1 | tail -3

# Verify
echo "   Verifying..."
echo "   Torch:  $(python3 -c 'import torch; print(torch.__version__)')"
python3 -c "from marker.converters.pdf import PdfConverter; print('   ✅ Marker OK')" 2>&1 || echo "   ⚠️  Marker import failed — check logs above"

# Workspace
mkdir -p /root/{audio,pdfs,docs/videos,docs/documents}

ELAPSED=$((SECONDS - START_TIME))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))
echo ""
echo "============================================"
echo "  ✅ Pod setup complete!"
echo "============================================"
echo "  Torch:  $(python3 -c 'import torch; print(torch.__version__)')"
echo "  CUDA:   $(python3 -c 'import torch; print(torch.version.cuda)')"
echo ""
echo "  ⏱️  Installed in ${MINS}m ${SECS}s"
echo ""
