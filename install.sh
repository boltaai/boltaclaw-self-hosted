#!/bin/bash

# Bolta OpenClaw Engine — Install Script
# Usage: curl -sL https://bolta.ai/install.sh | bash -s -- --token=YOUR_TOKEN
#
# Installs everything to ~/.boltaclaw/ — no sudo, no global packages.
# Requires: Node.js 22+, git

BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
GRAY="\033[90m"
RESET="\033[0m"

TOKEN=""

for arg in "$@"; do
  case $arg in
    --token=*) TOKEN="${arg#*=}" ;;
  esac
done

die() { echo -e "\n  ${RED}✗ $1${RESET}\n"; exit 1; }
step() { echo -e "\n  ${BLUE}[$1/5]${RESET} $2"; }

BOLTACLAW_HOME="$HOME/.boltaclaw"
INSTALL_DIR="$BOLTACLAW_HOME/engine"
BOLTACLAW_BIN="$BOLTACLAW_HOME/bin"
OC_DIR="$HOME/.openclaw-bolta"

echo -e "\n${BLUE}${BOLD}  ⚡ Bolta OpenClaw Engine Installer${RESET}"
echo -e "  ${GRAY}Everything installs to ~/.boltaclaw/ — no sudo needed.${RESET}\n"

# ─── Detect OS ─────────────────────────────────────────────────
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then OS="linux"
fi
echo -e "  ${GRAY}OS: $OS | Home: $HOME${RESET}"

# ─── 1. Node.js 22+ ───────────────────────────────────────────
step 1 "Checking Node.js 22+..."

need_node_upgrade() {
  if ! command -v node &>/dev/null; then return 0; fi
  local ver=$(node -v | sed 's/v//' | cut -d. -f1)
  [ "$ver" -lt 22 ]
}

if need_node_upgrade; then
  echo -e "  ${YELLOW}Node.js 22+ required (found: $(node -v 2>/dev/null || echo 'none'))${RESET}"

  if [[ "$OS" == "macos" ]]; then
    if command -v brew &>/dev/null; then
      echo -e "  ${GRAY}Installing via Homebrew...${RESET}"
      brew install node@22 2>/dev/null || brew upgrade node 2>/dev/null
      brew link --overwrite node@22 2>/dev/null || true
      # Homebrew keg-only: add to PATH for this session + future shells
      if [ -d "/opt/homebrew/opt/node@22/bin" ]; then
        export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
      elif [ -d "/usr/local/opt/node@22/bin" ]; then
        export PATH="/usr/local/opt/node@22/bin:$PATH"
      fi
    else
      die "Install Homebrew first (https://brew.sh) or Node.js 22+ (https://nodejs.org)"
    fi
  elif [[ "$OS" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    else
      die "Install Node.js 22+ manually: https://nodejs.org"
    fi
  else
    die "Install Node.js 22+ manually: https://nodejs.org"
  fi

  # Verify upgrade worked
  if need_node_upgrade; then
    die "Node.js 22+ is required but upgrade failed. Current: $(node -v 2>/dev/null || echo 'none'). Install manually: https://nodejs.org"
  fi
fi

echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# Check git
command -v git &>/dev/null || die "Git is required. Install: https://git-scm.com"
echo -e "  ${GREEN}✓${RESET} Git $(git --version | cut -d' ' -f3)"

# ─── 2. Clone/Update BoltaClaw ────────────────────────────────
step 2 "Installing BoltaClaw..."
mkdir -p "$BOLTACLAW_HOME"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${GRAY}Updating existing install...${RESET}"
  cd "$INSTALL_DIR" || die "Cannot cd to $INSTALL_DIR"
  git fetch origin main --quiet 2>/dev/null
  git reset --hard origin/main --quiet 2>/dev/null || true
else
  rm -rf "$INSTALL_DIR" 2>/dev/null
  git clone --depth 1 https://github.com/boltaai/boltaclaw-self-hosted.git "$INSTALL_DIR" || \
    die "Failed to clone BoltaClaw"
  cd "$INSTALL_DIR" || die "Cannot cd to $INSTALL_DIR"
fi

echo -e "  ${GRAY}Installing dependencies...${RESET}"
npm install --omit=dev 2>&1 | tail -3
[ ${PIPESTATUS[0]:-$?} -eq 0 ] || die "npm install failed in $INSTALL_DIR"

echo -e "  ${GREEN}✓${RESET} BoltaClaw engine ready"

# ─── 3. Install OpenClaw locally ──────────────────────────────
step 3 "Installing OpenClaw..."
mkdir -p "$OC_DIR"

# Create package.json if missing
[ -f "$OC_DIR/package.json" ] || echo '{"name":"openclaw-bolta","private":true}' > "$OC_DIR/package.json"

cd "$OC_DIR" || die "Cannot cd to $OC_DIR"
npm install --save openclaw@latest 2>&1 | grep -v "^npm warn" | tail -5

if [ -f "$OC_DIR/node_modules/.bin/openclaw" ]; then
  echo -e "  ${GREEN}✓${RESET} OpenClaw installed locally"
else
  die "OpenClaw install failed — binary not found at $OC_DIR/node_modules/.bin/openclaw"
fi

# ─── 4. Create boltaclaw command + PATH ───────────────────────
step 4 "Setting up commands..."
mkdir -p "$BOLTACLAW_BIN"
chmod +x "$INSTALL_DIR/src/cli.js"

cat > "$BOLTACLAW_BIN/boltaclaw" << 'WRAPPER'
#!/bin/bash
exec node "$HOME/.boltaclaw/engine/src/cli.js" "$@"
WRAPPER
chmod +x "$BOLTACLAW_BIN/boltaclaw"

export PATH="$BOLTACLAW_BIN:$PATH"

# Add to shell profile
SHELL_RC="$HOME/.zshrc"
[ -f "$HOME/.bashrc" ] && ! [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.bashrc"
if ! grep -q '.boltaclaw/bin' "$SHELL_RC" 2>/dev/null; then
  printf '\n# BoltaClaw\nexport PATH="$HOME/.boltaclaw/bin:$PATH"\n' >> "$SHELL_RC"
  echo -e "  ${GRAY}Added to PATH in $(basename "$SHELL_RC")${RESET}"
fi

echo -e "  ${GREEN}✓${RESET} boltaclaw command ready"

# ─── 5. Download skills ──────────────────────────────────────
step 5 "Downloading agent skills..."
SKILLS_DIR="$BOLTACLAW_HOME/skills"

if [ -d "$SKILLS_DIR/.git" ]; then
  cd "$SKILLS_DIR" && git pull --quiet 2>/dev/null || true
  echo -e "  ${GREEN}✓${RESET} bolta-skills updated"
else
  rm -rf "$SKILLS_DIR" 2>/dev/null
  git clone --depth 1 https://github.com/boltaai/bolta-skills.git "$SKILLS_DIR" 2>/dev/null && \
    echo -e "  ${GREEN}✓${RESET} bolta-skills downloaded" || \
    echo -e "  ${YELLOW}⚠ Skipped (agents work without local skills)${RESET}"
fi

# ─── Done ─────────────────────────────────────────────────────
echo -e "\n  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}  ✅ Installation complete!${RESET}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${GRAY}Installed to:${RESET}"
echo -e "    Engine:   $INSTALL_DIR"
echo -e "    OpenClaw: $OC_DIR"
echo -e "    Skills:   $SKILLS_DIR"
echo -e "    Command:  $BOLTACLAW_BIN/boltaclaw"
echo ""

if [ -n "$TOKEN" ]; then
  echo -e "  ${BLUE}Connecting to Bolta Cloud...${RESET}\n"
  exec "$BOLTACLAW_BIN/boltaclaw" start --token="$TOKEN"
else
  echo -e "  ${BOLD}Next steps:${RESET}\n"
  echo -e "    ${BOLD}boltaclaw start --token=YOUR_TOKEN${RESET}"
  echo -e ""
  echo -e "  ${GRAY}Get your token from Settings → Self-Hosted in the Bolta dashboard.${RESET}\n"
fi
