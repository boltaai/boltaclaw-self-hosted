import { WSClient } from './ws-client.js';
import { Database } from './db.js';
import { Executor } from './executor.js';

const BOLTA_WS_URL = process.env.BOLTA_WS_URL || 'wss://api.bolta.ai/ws/runner';
const HEARTBEAT_INTERVAL_MS = 30_000;

export class Runner {
  constructor(config, opts = {}) {
    this.config = config;
    this.verbose = opts.verbose || false;
    this.db = new Database(config.dataDir);
    this.executor = new Executor(config, this.db);
    this.ws = null;
    this.heartbeatTimer = null;
    this.activeJobs = new Map();
  }

  async connect() {
    const token = this.config.get('runner_key') || this.config.get('install_token');
    if (!token) throw new Error('No authentication token available');

    this.ws = new WSClient(BOLTA_WS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      verbose: this.verbose,
    });

    // Register message handlers
    this.ws.on('handshake_complete', (data) => this._onHandshake(data));
    this.ws.on('job_dispatch', (data) => this._onJobDispatch(data));
    this.ws.on('job_cancel', (data) => this._onJobCancel(data));
    this.ws.on('config_sync', (data) => this._onConfigSync(data));
    this.ws.on('ping', () => this.ws.send('pong', {}));
    this.ws.on('error', (data) => {
      console.error(`  ❌ Server error: ${data.message || 'Unknown'}`);
    });

    await this.ws.connect();

    // Authenticate after connection (consumer expects auth as first message)
    this.ws.send('auth', { token });

    // Re-authenticate on reconnect
    this.ws.on('reconnected', () => {
      const currentToken = this.config.get('runner_key') || this.config.get('install_token');
      if (currentToken) this.ws.send('auth', { token: currentToken });
    });

    this._startHeartbeat();
  }

  async disconnect() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) await this.ws.close();
  }

  // --- Event Handlers ---

  _onHandshake(data) {
    // Install token → persistent runner key swap
    if (data.runner_key) {
      this.config.set('runner_key', data.runner_key);
      this.config.delete('install_token'); // Burn the install token
    }
    if (data.workspace_id) {
      this.config.set('workspace_id', data.workspace_id);
    }
    if (this.verbose) {
      console.log(`  Handshake complete — workspace: ${data.workspace_id}`);
    }
  }

  async _onJobDispatch(data) {
    const { job_id, agent_slug, input, context } = data;

    if (this.verbose) {
      console.log(`  📥 Job received: ${agent_slug} — ${job_id}`);
    }

    // Store job locally
    this.db.createJob(job_id, this.config.get('workspace_id'), agent_slug, input);

    // Execute
    try {
      this.activeJobs.set(job_id, { status: 'running', started: Date.now() });

      const result = await this.executor.execute({
        jobId: job_id,
        agentSlug: agent_slug,
        input,
        context,
        onProgress: (event) => {
          // Stream progress back to Bolta Cloud
          this.ws.send('job_progress', { job_id, event });
        },
      });

      // Report completion
      this.ws.send('job_complete', { job_id, output: result });
      this.db.updateJob(job_id, 'complete', result);
      this.activeJobs.delete(job_id);

      if (this.verbose) {
        console.log(`  ✅ Job complete: ${job_id}`);
      }
    } catch (err) {
      this.ws.send('job_failed', { job_id, error: err.message });
      this.db.updateJob(job_id, 'failed', null, err.message);
      this.activeJobs.delete(job_id);

      console.error(`  ❌ Job failed: ${job_id} — ${err.message}`);
    }
  }

  _onJobCancel(data) {
    const { job_id } = data;
    const job = this.activeJobs.get(job_id);
    if (job) {
      job.cancelled = true;
      this.activeJobs.delete(job_id);
      this.db.updateJob(job_id, 'cancelled');
      if (this.verbose) console.log(`  🚫 Job cancelled: ${job_id}`);
    }
  }

  _onConfigSync(data) {
    // Bolta Cloud pushes config updates (voice profile, agent settings, etc.)
    if (data.config) {
      for (const [key, value] of Object.entries(data.config)) {
        this.config.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      if (this.verbose) console.log('  🔄 Config synced from Bolta Cloud');
    }
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.connected) {
        this.ws.send('heartbeat', {
          active_jobs: this.activeJobs.size,
          uptime: process.uptime(),
          memory: process.memoryUsage().rss,
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}
