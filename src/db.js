import Database from 'better-sqlite3';
import { join } from 'path';

export class LocalDB {
  constructor(dataDir) {
    this.dbPath = join(dataDir, 'boltaclaw.sqlite');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input TEXT,
        output TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key);
    `);
  }

  // --- Jobs ---

  createJob(id, workspaceId, agentSlug, input) {
    this.db.prepare(
      'INSERT INTO jobs (id, workspace_id, agent_slug, status, input) VALUES (?, ?, ?, ?, ?)'
    ).run(id, workspaceId, agentSlug, 'running', JSON.stringify(input));
  }

  updateJob(id, status, output = null, error = null) {
    this.db.prepare(
      "UPDATE jobs SET status = ?, output = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, output ? JSON.stringify(output) : null, error, id);
  }

  getJob(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  getRecentJobs(limit = 50) {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // --- Memory ---

  remember(key, value) {
    this.db.prepare(
      "INSERT OR REPLACE INTO memory (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).run(key, JSON.stringify(value));
  }

  recall(key) {
    const row = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  searchMemory(query) {
    return this.db.prepare(
      "SELECT * FROM memory WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT 20"
    ).all(`%${query}%`, `%${query}%`);
  }

  // --- Config ---

  getConfig(key) {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row?.value || null;
  }

  setConfig(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  deleteConfig(key) {
    this.db.prepare('DELETE FROM config WHERE key = ?').run(key);
  }
}

// Re-export as Database for backward compat
export { LocalDB as Database };
