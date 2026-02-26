#!/bin/bash

# Bolta OpenClaw Engine — Install Script
# Usage: curl -sL https://bolta.ai/install.sh | bash -s -- --token=YOUR_TOKEN
#
# Steps:
# 1. Checks/installs Node.js 18+, git
# 2. Installs OpenClaw (the agent runtime)
# 3. Clones & links BoltaClaw (the Bolta bridge)
# 4. Clones bolta-skills
# 5. Starts the engine and connects to Bolta Cloud

BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
GRAY="\033[90m"
RESET="\033[0m"

TOKEN=""
VERBOSE=0

# Parse args
for arg in "$@"; do
  case $arg in
    --token=*)
      TOKEN="${arg#*=}"
      ;;
    --verbose)
      VERBOSE=1
      ;;
  esac
done

die() { echo -e "\n  ${RED}✗ $1${RESET}\n"; exit 1; }
step() { echo -e "  ${BLUE}[$1/6]${RESET} $2"; }

echo -e "\n${BLUE}${BOLD}  ⚡ Bolta OpenClaw Engine Installer${RESET}\n"

# --- Fix npm cache ownership (common issue after sudo npm install) ---
if [ -d "$HOME/.npm" ] && [ "$(stat -f %u "$HOME/.npm" 2>/dev/null || stat -c %u "$HOME/.npm" 2>/dev/null)" != "$(id -u)" ]; then
  echo -e "  ${GRAY}Fixing npm cache permissions...${RESET}"
  sudo chown -R "$(whoami)" "$HOME/.npm" 2>/dev/null || true
fi

# --- Detect OS ---
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
fi
echo -e "  ${GRAY}OS: $OS ($OSTYPE)${RESET}\n"

# --- 1. Check Node.js ---
step 1 "Checking Node.js..."
install_node() {
  echo -e "  ${YELLOW}Node.js not found. Installing...${RESET}"
  if [[ "$OS" == "macos" ]]; then
    if command -v brew &>/dev/null; then
      brew install node
    else
      die "Please install Homebrew first: https://brew.sh — then re-run"
    fi
  elif [[ "$OS" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm nodejs npm
    else
      die "Cannot auto-install Node.js. Install Node.js 18+ manually: https://nodejs.org"
    fi
  else
    die "Unsupported OS. Install Node.js 18+ manually: https://nodejs.org"
  fi
}

if ! command -v node &>/dev/null; then
  install_node
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${YELLOW}Node.js 18+ required (found v$NODE_VERSION). Upgrading...${RESET}"
  install_node
fi
echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# --- Check git ---
if ! command -v git &>/dev/null; then
  echo -e "  ${YELLOW}Git not found. Installing...${RESET}"
  if [[ "$OS" == "macos" ]]; then
    xcode-select --install 2>/dev/null || true
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y git
  fi
fi
command -v git &>/dev/null || die "Git is required but not installed"
echo -e "  ${GREEN}✓${RESET} Git $(git --version | cut -d' ' -f3)"

# --- 2. Skip (OpenClaw installed locally by BoltaClaw on first start) ---
step 2 "OpenClaw will be installed locally on first start..."
echo -e "  ${GREEN}✓${RESET} Deferred (installs to ~/.openclaw-bolta/)"

# --- 3. Install BoltaClaw ---
step 3 "Installing BoltaClaw..."
INSTALL_DIR="$HOME/.boltaclaw/engine"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${GRAY}Updating existing install...${RESET}"
  cd "$INSTALL_DIR"
  git pull --quiet || echo -e "  ${YELLOW}⚠ git pull failed, using existing version${RESET}"
else
  rm -rf "$INSTALL_DIR" 2>/dev/null
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 https://github.com/boltaai/boltaclaw-self-hosted.git "$INSTALL_DIR" || \
    die "Failed to clone BoltaClaw repo"
  cd "$INSTALL_DIR"
fi

echo -e "  ${GRAY}Installing dependencies...${RESET}"
npm install --omit=dev || {
  echo -e "  ${YELLOW}Retrying with cache clean...${RESET}"
  npm cache clean --force 2>/dev/null
  npm install --omit=dev || die "npm install failed in $INSTALL_DIR"
}

# Make cli.js executable and create a local wrapper
chmod +x "$INSTALL_DIR/src/cli.js"
BOLTACLAW_BIN="$HOME/.boltaclaw/bin"
mkdir -p "$BOLTACLAW_BIN"
cat > "$BOLTACLAW_BIN/boltaclaw" << WRAPPER
#!/bin/bash
exec node "$INSTALL_DIR/src/cli.js" "\$@"
WRAPPER
chmod +x "$BOLTACLAW_BIN/boltaclaw"

# Add to PATH for this session
export PATH="$BOLTACLAW_BIN:$PATH"

# Add to shell profile if not already there
SHELL_RC="$HOME/.zshrc"
[ -f "$HOME/.bashrc" ] && ! [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.bashrc"
if ! grep -q '.boltaclaw/bin' "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo '# BoltaClaw' >> "$SHELL_RC"
  echo 'export PATH="$HOME/.boltaclaw/bin:$PATH"' >> "$SHELL_RC"
  echo -e "  ${GRAY}Added ~/.boltaclaw/bin to PATH in $(basename $SHELL_RC)${RESET}"
fi

echo -e "  ${GREEN}✓${RESET} BoltaClaw installed"

# --- 4. mcporter installed locally by BoltaClaw ---
step 4 "MCP tools..."
echo -e "  ${GREEN}✓${RESET} Will be configured on first start"

# --- 5. Clone bolta-skills ---
step 5 "Downloading skills..."
SKILLS_DIR="$HOME/.boltaclaw/skills"
if [ -d "$SKILLS_DIR/.git" ]; then
  cd "$SKILLS_DIR" && git pull --quiet 2>/dev/null || true
  echo -e "  ${GREEN}✓${RESET} bolta-skills updated"
else
  rm -rf "$SKILLS_DIR" 2>/dev/null
  if git clone --depth 1 https://github.com/boltaai/bolta-skills.git "$SKILLS_DIR" 2>&1; then
    echo -e "  ${GREEN}✓${RESET} bolta-skills downloaded"
  else
    echo -e "  ${YELLOW}⚠ Could not download bolta-skills (agents will work without them)${RESET}"
  fi
fi

# --- 6. Start engine ---
echo -e "\n  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}  ✅ Installation complete!${RESET}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"

if [ -n "$TOKEN" ]; then
  step 6 "Connecting to Bolta Cloud..."
  echo ""
  exec boltaclaw start --token="$TOKEN"
else
  echo -e "  To connect to your Bolta workspace:\n"
  echo -e "    ${BOLD}boltaclaw start --token=YOUR_WORKSPACE_TOKEN${RESET}\n"
  echo -e "  Or run the interactive setup wizard:\n"
  echo -e "    ${BOLD}boltaclaw setup${RESET}\n"
  echo -e "  ${GRAY}Get your token from Settings → Self-Hosted in the Bolta dashboard.${RESET}\n"
fi
