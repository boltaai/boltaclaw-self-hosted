#!/bin/bash
set -e

# Bolta OpenClaw Engine — Install Script
# Usage: curl -sL https://bolta.ai/install.sh | bash -s -- --token=YOUR_TOKEN
#
# What this does:
# 1. Checks/installs Node.js 18+
# 2. Installs OpenClaw (the agent runtime)
# 3. Installs @boltaai/boltaclaw (the Bolta bridge)
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

echo -e "\n${BLUE}${BOLD}  ⚡ Bolta OpenClaw Engine Installer${RESET}\n"

# --- Detect OS ---
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
  OS="windows"
fi
echo -e "  ${GRAY}OS: $OS ($OSTYPE)${RESET}"

# --- Check Node.js ---
install_node() {
  echo -e "  ${YELLOW}Node.js not found. Installing...${RESET}"
  if [[ "$OS" == "macos" ]]; then
    if command -v brew &>/dev/null; then
      brew install node
    else
      echo -e "  ${RED}Please install Homebrew first: https://brew.sh${RESET}"
      echo -e "  ${GRAY}Then run: brew install node${RESET}"
      exit 1
    fi
  elif [[ "$OS" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo dnf install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo yum install -y nodejs
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm nodejs npm
    else
      echo -e "  ${RED}Cannot auto-install Node.js. Please install Node.js 18+ manually.${RESET}"
      exit 1
    fi
  else
    echo -e "  ${RED}Unsupported OS for auto-install. Please install Node.js 18+ manually.${RESET}"
    echo -e "  ${GRAY}https://nodejs.org/en/download${RESET}"
    exit 1
  fi
}

if ! command -v node &>/dev/null; then
  install_node
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${RED}Node.js 18+ required (found v$NODE_VERSION). Upgrading...${RESET}"
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
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y git
  fi
fi
echo -e "  ${GREEN}✓${RESET} Git $(git --version | cut -d' ' -f3)"

# --- Install OpenClaw ---
if command -v openclaw &>/dev/null; then
  OC_VERSION=$(openclaw --version 2>/dev/null | head -1)
  echo -e "  ${GREEN}✓${RESET} OpenClaw ${OC_VERSION} (existing)"
else
  echo -e "  Installing OpenClaw..."
  npm install -g openclaw 2>/dev/null || {
    echo -e "  ${YELLOW}npm install failed, trying with sudo...${RESET}"
    sudo npm install -g openclaw
  }
  echo -e "  ${GREEN}✓${RESET} OpenClaw installed"
fi

# --- Install mcporter (MCP tool bridge) ---
if command -v mcporter &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} mcporter $(mcporter --version 2>/dev/null) (existing)"
else
  echo -e "  Installing mcporter..."
  npm install -g mcporter 2>/dev/null || sudo npm install -g mcporter 2>/dev/null || true
  echo -e "  ${GREEN}✓${RESET} mcporter installed"
fi

# --- Install BoltaClaw ---
INSTALL_DIR="$HOME/.boltaclaw/engine"
echo -e "  Installing BoltaClaw..."
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR" && git pull --quiet 2>/dev/null
  npm install --production --silent 2>/dev/null
else
  rm -rf "$INSTALL_DIR" 2>/dev/null
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 https://github.com/boltaai/boltaclaw-self-hosted.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  npm install --production --silent
fi
npm link 2>/dev/null || sudo npm link 2>/dev/null || {
  # Fallback: add bin to PATH directly
  echo -e "  ${GRAY}Adding boltaclaw to PATH...${RESET}"
  export PATH="$INSTALL_DIR/node_modules/.bin:$INSTALL_DIR:$PATH"
}
echo -e "  ${GREEN}✓${RESET} BoltaClaw installed"

# --- Clone bolta-skills ---
SKILLS_DIR="$HOME/.boltaclaw/skills"
if [ -d "$SKILLS_DIR/.git" ]; then
  echo -e "  Updating bolta-skills..."
  cd "$SKILLS_DIR" && git pull --quiet 2>/dev/null || true
else
  echo -e "  Downloading bolta-skills..."
  rm -rf "$SKILLS_DIR" 2>/dev/null
  git clone --depth 1 https://github.com/boltaai/bolta-skills.git "$SKILLS_DIR" 2>/dev/null || {
    echo -e "  ${YELLOW}⚠ Could not clone bolta-skills. Agents will work without local skills.${RESET}"
  }
fi
echo -e "  ${GREEN}✓${RESET} bolta-skills ready"

# --- Summary ---
echo -e "\n  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}✅ Installation complete!${RESET}"
echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"

# --- Start engine if token provided ---
if [ -n "$TOKEN" ]; then
  echo -e "  ${BLUE}Starting engine...${RESET}\n"
  exec boltaclaw start --token="$TOKEN"
else
  echo -e "  To connect to your Bolta workspace:\n"
  echo -e "  ${BOLD}boltaclaw start --token=YOUR_WORKSPACE_TOKEN${RESET}\n"
  echo -e "  Or run the interactive setup wizard:\n"
  echo -e "  ${BOLD}boltaclaw setup${RESET}\n"
  echo -e "  ${GRAY}Get your token from Settings → Self-Hosted in the Bolta dashboard.${RESET}\n"
fi
