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
npm install -g @boltaai/boltaclaw
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
2. **The engine connects outbound** to Bolta Cloud via secure WebSocket (no port-forwarding needed)
3. **Bolta dashboard detects the connection** and lights up green
4. **You configure your agents** from the Bolta UI — voice, schedule, social accounts
5. **Jobs run locally** — LLM calls use your own API key (BYOK), drafts stay on your machine until you approve

## What Runs Where

| Component | Location | Why |
|-----------|----------|-----|
| LLM calls (Claude/GPT) | Your machine | BYOK — your key, your cost control |
| Agent memory | Your machine (SQLite) | Privacy — brand voice, drafts, history |
| Social OAuth tokens | Bolta Cloud | Security — managed OAuth flow |
| Job scheduling | Bolta Cloud → pushed to runner | Convenience — set schedules from UI |
| Post approval | Bolta Cloud (Inbox) | Workflow — review before publishing |
| Publishing | Bolta Cloud (via social APIs) | Reliability — managed API connections |

## Configuration

After first connection, configure via the Bolta dashboard or locally:

```bash
# Set your Claude API key (stored locally only)
boltaclaw config set ANTHROPIC_API_KEY sk-ant-...

# Connect a Telegram bot (optional)
boltaclaw config set TELEGRAM_BOT_TOKEN 123456:ABC...

# Check status
boltaclaw status
```

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
