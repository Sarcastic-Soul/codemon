#!/usr/bin/env bash
# build-all-platforms.sh — Cross-compile codemon for multiple targets
# Requires Bun >= 1.1.0 with cross-compilation support
set -e

VERSION=$(node -e "console.log(require('./package.json').version)")
OUTDIR="dist/release/v${VERSION}"

mkdir -p "$OUTDIR"

echo "🐉 Building codemon v${VERSION}"
echo ""

# Target list: <bun-target>:<output-name>
TARGETS=(
  "bun-linux-x64:codemon-linux-x64"
  "bun-linux-arm64:codemon-linux-arm64"
  "bun-darwin-x64:codemon-macos-x64"
  "bun-darwin-arm64:codemon-macos-arm64"
)

for entry in "${TARGETS[@]}"; do
  TARGET="${entry%%:*}"
  OUTNAME="${entry##*:}"
  echo "  🔨 Building $OUTNAME ($TARGET)..."
  bun build --compile --target="$TARGET" src/cli/index.tsx --outfile "$OUTDIR/$OUTNAME" 2>&1 \
    && echo "     ✅ $OUTDIR/$OUTNAME" \
    || echo "     ❌ Failed (cross-compile may need a Bun cross-compile executor)"
done

echo ""
echo "📦 Release artifacts:"
ls -lh "$OUTDIR/"

echo ""
echo "🏷️  To create checksums:"
echo "   cd $OUTDIR && sha256sum * > SHA256SUMS"
