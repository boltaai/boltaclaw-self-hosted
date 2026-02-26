#!/bin/bash
set -e

# Bolta OpenClaw Engine — Install Script
# Usage: curl -sL https://bolta.ai/install.sh | bash -s -- --token=YOUR_TOKEN

BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
RED="\033[31m"
RESET="\033[0m"

TOKEN=""

# Parse args
for arg in "$@"; do
  case $arg in
    --token=*)
      TOKEN="${arg#*=}"
      ;;
  esac
done

echo -e "\n${BLUE}${BOLD}  ⚡ Bolta OpenClaw Engine Installer${RESET}\n"

# --- Check Node.js ---
if ! command -v node &>/dev/null; then
  echo -e "  ${RED}Node.js not found.${RESET} Installing..."
  if command -v brew &>/dev/null; then
    brew install node
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  else
    echo -e "  ${RED}Cannot auto-install Node.js. Please install Node.js 18+ and retry.${RESET}"
    exit 1
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${RED}Node.js 18+ required (found v$NODE_VERSION). Please upgrade.${RESET}"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# --- Install boltaclaw ---
echo -e "  Installing @boltaai/boltaclaw..."
npm install -g @boltaai/boltaclaw@latest 2>/dev/null || {
  # If not published to npm yet, install from GitHub
  npm install -g github:boltaai/boltaclaw-self-hosted 2>/dev/null || {
    echo -e "  ${RED}Install failed. Trying local clone...${RESET}"
    INSTALL_DIR="$HOME/.boltaclaw/engine"
    mkdir -p "$INSTALL_DIR"
    git clone --depth 1 https://github.com/boltaai/boltaclaw-self-hosted.git "$INSTALL_DIR" 2>/dev/null || true
    cd "$INSTALL_DIR"
    npm install
    npm link
  }
}
echo -e "  ${GREEN}✓${RESET} boltaclaw installed"

# --- Clone bolta-skills ---
SKILLS_DIR="$HOME/.boltaclaw/skills"
if [ -d "$SKILLS_DIR" ]; then
  echo -e "  Updating bolta-skills..."
  cd "$SKILLS_DIR" && git pull --quiet 2>/dev/null || true
else
  echo -e "  Downloading bolta-skills..."
  git clone --depth 1 https://github.com/boltaai/bolta-skills.git "$SKILLS_DIR" 2>/dev/null || {
    echo -e "  ${RED}Warning: Could not clone bolta-skills. Agents will work without local skills.${RESET}"
  }
fi
echo -e "  ${GREEN}✓${RESET} bolta-skills ready"

# --- Start engine ---
if [ -n "$TOKEN" ]; then
  echo -e "\n  ${BLUE}Starting engine...${RESET}\n"
  boltaclaw start --token="$TOKEN"
else
  echo -e "\n  ${GREEN}${BOLD}Installation complete!${RESET}"
  echo -e "\n  To connect to your Bolta workspace:"
  echo -e "  ${BOLD}boltaclaw start --token=YOUR_WORKSPACE_TOKEN${RESET}"
  echo -e "\n  Get your token from Settings → Self-Hosted in the Bolta dashboard.\n"
fi
