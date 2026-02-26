import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { LocalDB } from './db.js';

const DEFAULT_DATA_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.boltaclaw'
);

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
    // Env vars take precedence
    const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (process.env[envKey]) return process.env[envKey];

    return this._db.getConfig(key);
  }

  set(key, value) {
    this._db.setConfig(key, value);
  }

  delete(key) {
    this._db.deleteConfig(key);
  }

  getAll() {
    // Return all config as object
    const rows = this._db.db.prepare('SELECT key, value FROM config').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}
