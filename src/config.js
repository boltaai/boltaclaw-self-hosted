import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { LocalDB } from './db.js';

const DEFAULT_DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.boltaclaw'
);

/**
 * Config manager for BoltaClaw.
 *
 * Stores config in a local SQLite database at ~/.boltaclaw/boltaclaw.sqlite.
 * Environment variables override SQLite values.
 *
 * Key storage:
 *   - install_token   — one-time handshake token (burned after use)
 *   - runner_key      — persistent auth key from Bolta Cloud
 *   - workspace_id    — Bolta workspace ID
 *   - gateway_token   — local OpenClaw gateway auth token
 *   - gateway_port    — local OpenClaw gateway port
 *   - ANTHROPIC_API_KEY — Claude API key (BYOK, never leaves machine)
 *   - OPENAI_API_KEY    — OpenAI key (optional, for embeddings)
 *   - TELEGRAM_BOT_TOKEN — Telegram bot token (optional)
 *   - TELEGRAM_USER_ID   — Telegram user ID for allowlist
 *   - SLACK_BOT_TOKEN    — Slack bot token (optional)
 *   - SLACK_APP_TOKEN    — Slack app-level token (optional)
 *   - voice_profile      — Brand voice description (synced from cloud)
 *   - skills_dir         — Path to bolta-skills directory
 *   - cloud_*            — Config values pushed from Bolta Cloud
 */
export class Config {
  constructor(dataDir) {
    this.dataDir = dataDir || process.env.BOLTACLAW_DATA_DIR || DEFAULT_DATA_DIR;

    // Ensure data directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this._db = new LocalDB(this.dataDir);
  }

  get(key) {
    // Env vars take precedence (check both exact and uppercased)
    if (process.env[key]) return process.env[key];
    const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (process.env[envKey]) return process.env[envKey];

    // Special Bolta env vars
    const boltaEnvMap = {
      'install_token': 'BOLTA_TOKEN',
      'ANTHROPIC_API_KEY': 'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY': 'OPENAI_API_KEY',
      'TELEGRAM_BOT_TOKEN': 'TELEGRAM_BOT_TOKEN',
    };
    const envAlias = boltaEnvMap[key];
    if (envAlias && process.env[envAlias]) return process.env[envAlias];

    return this._db.getConfig(key);
  }

  set(key, value) {
    this._db.setConfig(key, value);
  }

  delete(key) {
    this._db.deleteConfig(key);
  }

  has(key) {
    return this.get(key) !== null && this.get(key) !== undefined;
  }

  getAll() {
    const rows = this._db.db.prepare('SELECT key, value FROM config').all();
    const result = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    // Redact sensitive keys for display
    for (const k of Object.keys(result)) {
      if (k.toLowerCase().includes('key') || k.toLowerCase().includes('token') || k.toLowerCase().includes('secret')) {
        if (result[k] && result[k].length > 10) {
          result[k] = result[k].substring(0, 8) + '...' + result[k].substring(result[k].length - 4);
        }
      }
    }
    return result;
  }
}
