# boltaclaw-self-hosted

Self-hosted launcher for BoltaClaw.

## Run with npx

```bash
npx boltaclaw setup
npx boltaclaw start --token=YOUR_TOKEN
```

## Commands

- `boltaclaw setup` – install/update engine + OpenClaw + skills locally (`~/.boltaclaw`, `~/.openclaw-bolta`)
- `boltaclaw start --token=...` – setup (if needed), save token, and start gateway
- `boltaclaw status` – installation + gateway status
- `boltaclaw logs` – print OpenClaw status
- `boltaclaw update` – update engine/deps and restart gateway

## Notes

- Requires Node.js 22+
- No global npm install required (works via `npx`)
- Installs to user home (no sudo)
