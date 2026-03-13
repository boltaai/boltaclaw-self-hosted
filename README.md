# Bolta OpenClaw Engine (Self-Hosted)

> Run your Bolta AI agents locally. Your data stays on your machine. Your API keys stay on your machine.

## What is this?

The Bolta OpenClaw Engine lets you run Bolta's AI social media agents on your own machine while controlling them from the Bolta dashboard. Think of it like GitHub Actions runners — your machine does the work, Bolta provides the UI.

```
┌─────────────────────────────────┐
│  Bolta Cloud (Control Tower)    │
│  - Dashboard / Conductor UI     │
│  - Job queue / scheduler        │
│  - OAuth tokens / social APIs   │
│  - WebSocket relay              │
└──────────┬──────────────────────┘
           │ outbound WSS
           │ (from your machine)
┌──────────▼──────────────────────┐
│  Your Machine (The Factory)     │
│  - OpenClaw daemon              │
│  - bolta-skills (37 skills)     │
│  - Bolta MCP client             │
│  - Local SQLite (memory/drafts) │
│  - Claude API (your own key)    │
│  - Optional: Telegram/Slack bot │
└─────────────────────────────────┘
```

## Quick Start

### One-Line Install

```bash
curl -sL https://bolta.ai/install.sh | bash -s -- --token=YOUR_WORKSPACE_TOKEN
```

Get your workspace token from **Settings → Self-Hosted** in the [Bolta dashboard](https://boltathread.com/dashboard).

### Manual Install

```bash
# Install OpenClaw (the agent runtime)
npm install -g openclaw

# Install BoltaClaw (the Bolta bridge)
npm install -g @boltaai/boltaclaw

# Interactive setup
boltaclaw setup --token=YOUR_WORKSPACE_TOKEN

# Or start directly
boltaclaw start --token=YOUR_WORKSPACE_TOKEN
```

### Docker

```bash
docker run -d \
  -e BOLTA_TOKEN=YOUR_WORKSPACE_TOKEN \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v boltaclaw-data:/data \
  ghcr.io/boltaai/boltaclaw:latest
```

## How It Works

1. **You install the engine** on your machine (Mac, Linux, Windows WSL, Docker, VPS — anywhere)
2. **The install script sets up [OpenClaw](https://openclaw.ai)** — the open-source agent runtime that handles LLM calls, tool execution, memory, scheduling, and channel integrations
3. **BoltaClaw bridges OpenClaw to Bolta Cloud** — an outbound WebSocket connection (no port-forwarding needed)
4. **Bolta dashboard detects the connection** and lights up green
5. **You configure your agents** from the Bolta UI — voice, schedule, social accounts
6. **Jobs run locally** through OpenClaw — LLM calls use your own API key (BYOK), drafts stay on your machine until you approve

### What's OpenClaw?

[OpenClaw](https://openclaw.ai) is the open-source agent runtime that powers the local engine. It provides:

- **Agent gateway** — WebSocket server for agent sessions with multi-turn conversations
- **Tool execution** — Sandboxed shell, browser automation, file I/O
- **Memory** — LanceDB vector store for persistent agent memory
- **Channels** — Telegram, Discord, Slack, WhatsApp integrations
- **Skills** — Extensible skill system (bolta-skills + community skills via ClawHub)
- **Scheduling** — Cron jobs for recurring agent tasks
- **Heartbeats** — Proactive agent check-ins

BoltaClaw is a thin bridge layer that connects OpenClaw to your Bolta workspace.

## What Runs Where

| Component | Location | Why |
|-----------|----------|-----|
| LLM calls (Claude/GPT) | Your machine | BYOK — your key, your cost control |
| Agent memory | Your machine (SQLite) | Privacy — brand voice, drafts, history |
| Social OAuth tokens | Bolta Cloud | Security — managed OAuth flow |
| Job scheduling | Bolta Cloud → pushed to runner | Convenience — set schedules from UI |
| Post approval | Bolta Cloud (Inbox) | Workflow — review before publishing |
| Publishing | Bolta Cloud (via social APIs) | Reliability — managed API connections |

## CLI Commands

```bash
# Start the engine (connects to Bolta Cloud)
boltaclaw start --token=YOUR_TOKEN

# Interactive setup wizard
boltaclaw setup

# Guided onboarding (includes optional OpenClaw native onboard)
boltaclaw onboard --token=YOUR_TOKEN

# Check engine status (OpenClaw, gateway, connection, keys)
boltaclaw status

# Configure locally stored settings
boltaclaw config set ANTHROPIC_API_KEY sk-ant-...   # BYOK — never leaves your machine
boltaclaw config set MODEL_PRIMARY anthropic/claude-sonnet-4-6
boltaclaw config set TELEGRAM_BOT_TOKEN 123456:ABC... # Optional chat channel
boltaclaw config get ANTHROPIC_API_KEY

# Tail OpenClaw gateway logs
boltaclaw logs -f

# Gateway lifecycle controls
boltaclaw gateway health
boltaclaw gateway stop
boltaclaw gateway start
boltaclaw gw health   # alias

# Run native OpenClaw commands with bolta profile
boltaclaw openclaw gateway health
boltaclaw openclaw uninstall
boltaclaw oc gateway health   # alias
boltaclaw action --help

# Diagnose local setup and command failures
boltaclaw doctor

# Remove local OpenClaw profile (and optionally local Boltaclaw data)
boltaclaw uninstall --yes
boltaclaw uninstall --yes --purge

# Update OpenClaw + bolta-skills
boltaclaw update
```

## Boltaclaw-First Command Model

Use Boltaclaw commands for normal operations. They keep Bolta-specific safety, profile isolation, and cloud bridge behavior consistent.

- Prefer `boltaclaw start|status|doctor|gateway|config|run|chat`
- Use `boltaclaw openclaw ...` (or `boltaclaw oc ...`) for advanced OpenClaw utilities not yet wrapped by Boltaclaw
- The passthrough always runs with `--profile bolta` so it stays inside Boltaclaw's isolated runtime
- Avoid running raw `openclaw` without the Bolta profile unless you intentionally want a separate environment

## Troubleshooting Quick Reference

```bash
# 1) Fast diagnostics
boltaclaw doctor

# 2) Gateway not healthy
boltaclaw gateway start
boltaclaw gateway health
boltaclaw logs -f

# 3) Verify OpenClaw command behavior under Boltaclaw profile
boltaclaw oc gateway health
boltaclaw oc --help

# 4) Re-onboard if token/key/config drifted
boltaclaw onboard --token=YOUR_TOKEN

# 5) Full cleanup (last resort)
boltaclaw uninstall --yes --purge
```

Common causes of command failures:
- Missing API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)
- Gateway not running on configured local port (`127.0.0.1:18789` by default)
- Token/config drift after reinstall or machine migration
- Running native `openclaw` outside the `bolta` profile by accident

## Security

- **Outbound-only connections** — your machine initiates all connections, no inbound ports needed
- **BYOK (Bring Your Own Key)** — API keys never leave your machine
- **Token burn** — install tokens are single-use; a persistent runner key is issued after handshake
- **End-to-end encryption** — WSS (TLS) for all cloud communication
- **Local storage** — memory, drafts, and history in local SQLite

## Requirements

- Node.js 18+ (auto-installed by install script)
- Internet connection (for Bolta Cloud + LLM APIs)
- Claude API key (Anthropic) or OpenAI API key

## Documentation

- [Bolta API Docs](https://bolta.ai/docs/api)
- [Bolta Skills](https://github.com/boltaai/bolta-skills)
- [Architecture Spec](https://docs.bolta.ai/self-hosted/architecture)

## License

MIT — see [LICENSE](./LICENSE)
