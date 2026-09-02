#!/usr/bin/env bash
#
# Install paper-orchestra globally.
#
#   curl -fsSL https://raw.githubusercontent.com/a-green-hand-jack/paper-orchestra/main/scripts/install.sh | bash
#
# Or, from a clone:
#
#   ./scripts/install.sh
#
# Installs from a temporary clone when piped, or from the repository you are
# standing in when run directly. Re-running upgrades in place.

set -euo pipefail

REPO="${PAPER_ORCHESTRA_REPO:-https://github.com/a-green-hand-jack/paper-orchestra.git}"
REF="${PAPER_ORCHESTRA_REF:-main}"

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

die() { red "error: $*"; exit 1; }

# --- Prerequisites ---------------------------------------------------------
# Only what the INSTALL needs. Everything the RUN needs is reported by
# `paper-orchestra doctor`, which is more informative than a check here and
# stays correct as requirements change.

command -v node >/dev/null 2>&1 || die "node is required but not on PATH. Install Node.js >= 20."
command -v npm  >/dev/null 2>&1 || die "npm is required but not on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js >= 20 is required; found $(node -v)."
fi

# --- Source ----------------------------------------------------------------

cleanup() { [ -n "${TMPDIR_CLONE:-}" ] && rm -rf "$TMPDIR_CLONE"; }
trap cleanup EXIT

if [ -f "package.json" ] && grep -q '"name": "paper-orchestra"' package.json 2>/dev/null; then
  SRC="$(pwd)"
  bold "Installing paper-orchestra from $SRC"
else
  command -v git >/dev/null 2>&1 || die "git is required to fetch the repository."
  TMPDIR_CLONE="$(mktemp -d)"
  SRC="$TMPDIR_CLONE/paper-orchestra"
  bold "Installing paper-orchestra from $REPO ($REF)"
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC" >/dev/null 2>&1 \
    || die "could not clone $REPO at $REF"
fi

# --- Build and link --------------------------------------------------------

cd "$SRC"
info "installing dependencies..."
npm install --silent --no-fund --no-audit >/dev/null

info "building..."
npm run build --silent >/dev/null

info "linking globally..."
# `npm link` writes into npm's global prefix. When that is a root-owned
# directory the failure is a wall of EACCES, so say what to do about it.
if ! npm link --silent >/dev/null 2>&1; then
  PREFIX="$(npm config get prefix)"
  red "npm link failed writing to $PREFIX"
  red ""
  red "Either give npm a writable prefix (recommended):"
  red "    npm config set prefix ~/.npm-global"
  red "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add to your shell profile"
  red "then re-run this installer. Or install with sudo."
  exit 1
fi

# --- Verify ----------------------------------------------------------------

if ! command -v paper-orchestra >/dev/null 2>&1; then
  PREFIX="$(npm config get prefix)"
  red "installed, but 'paper-orchestra' is not on PATH."
  red "Add npm's global bin directory to your PATH:"
  red "    export PATH=\"$PREFIX/bin:\$PATH\""
  exit 1
fi

echo
bold "Installed $(paper-orchestra --version)"
echo
info "Check the environment:   paper-orchestra doctor"
info "Write a paper:           cd <your-materials>/ && paper-orchestra write --allow-lkm-spend"
echo
