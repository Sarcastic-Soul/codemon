#!/usr/bin/env bash
# install.sh — Install codemon binary to /usr/local/bin (or ~/bin)
set -e

BINARY="dist/codemon"
INSTALL_DIR="/usr/local/bin"

# Build if binary doesn't exist
if [ ! -f "$BINARY" ]; then
  echo "⚙️  Building codemon binary..."
  bun run build
fi

# Try system-wide install, fall back to ~/bin
if [ -w "$INSTALL_DIR" ]; then
  cp "$BINARY" "$INSTALL_DIR/codemon"
  chmod +x "$INSTALL_DIR/codemon"
  echo "✅ Installed: $INSTALL_DIR/codemon"
else
  mkdir -p "$HOME/.local/bin"
  cp "$BINARY" "$HOME/.local/bin/codemon"
  chmod +x "$HOME/.local/bin/codemon"
  echo "✅ Installed: $HOME/.local/bin/codemon"
  echo ""
  echo "⚠️  Make sure ~/.local/bin is in your PATH:"
  echo "   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
  echo "   source ~/.bashrc"
fi

echo ""
echo "🐉 Run: codemon --help"
