/**
 * Bolta Cloud Bridge
 *
 * Maintains an outbound WebSocket connection to Bolta Cloud.
 * Receives job dispatches, routes them to the local OpenClaw agent,
 * and streams results back.
 *
 * This is the "glue" between Bolta Cloud (Control Tower) and
 * the local OpenClaw engine (The Factory).
 *
 * Flow:
 *   Bolta Cloud → [WSS] → Bridge → OpenClaw Agent → Bridge → [WSS] → Bolta Cloud
 */

import { WSClient } from './ws-client.js';
import { Database } from './db.js';

const BOLTA_WS_URL = process.env.BOLTA_WS_URL || 'wss://api.bolta.ai/ws/runner';
const HEARTBEAT_INTERVAL_MS = 30_000;

export class Bridge {
  constructor(config, openclawManager, opts = {}) {
    this.config = config;
    this.ocManager = openclawManager;
    this.verbose = opts.verbose || false;
    this.db = new Database(config.dataDir);
    this.ws = null;
    this.heartbeatTimer = null;
    this.activeJobs = new Map();
  }

  async connect() {
    const token = this.config.get('runner_key') || this.config.get('install_token');
    if (!token) throw new Error('No authentication token available');

    this.ws = new WSClient(BOLTA_WS_URL, {
      verbose: this.verbose,
    });

    // Register message handlers
    this.ws.on('handshake_complete', (data) => this._onHandshake(data));
    this.ws.on('job_dispatch', (data) => this._onJobDispatch(data));
    this.ws.on('job_cancel', (data) => this._onJobCancel(data));
    this.ws.on('config_sync', (data) => this._onConfigSync(data));
    this.ws.on('ping', () => this.ws.send('pong', {}));
    this.ws.on('error', (data) => {
      if (this.verbose) console.error(`  ❌ Server error: ${data.message || 'Unknown'}`);
    });

    // Reconnect handler
    this.ws.on('reconnected', () => {
      const currentToken = this.config.get('runner_key') || this.config.get('install_token');
      if (currentToken) this.ws.send('auth', { token: currentToken });
    });

    await this.ws.connect();

    // Authenticate (consumer expects auth as first message)
    this.ws.send('auth', { token });

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
      if (this.verbose) console.log('  🔑 Runner key received, install token burned');
    }
    if (data.workspace_id) {
      this.config.set('workspace_id', data.workspace_id);
    }
    // Store Bolta API key for MCP
    if (data.api_key) {
      this.config.set('BOLTA_API_KEY', data.api_key);
    }
    // Sync any config from cloud
    if (data.config) {
      this.ocManager.applyCloudConfig(data.config);
    }
    console.log(`  ✅ Handshake complete — workspace: ${data.workspace_id}`);
  }

  async _onJobDispatch(data) {
    const { job_id, run_id, agent_slug, input, context } = data;

    console.log(`  📥 Job received: ${agent_slug} — ${job_id}`);

    // Store job locally
    this.db.createJob(job_id, this.config.get('workspace_id'), agent_slug, input);
    this.activeJobs.set(job_id, { status: 'running', started: Date.now(), agent_slug });

    // Report progress: starting
    this.ws.send('job_progress', {
      job_id,
      event: { type: 'status', message: `${agent_slug} is thinking...` },
    });

    try {
      // Build system context from workspace + agent context
      const systemContext = this._buildSystemContext(agent_slug, context);

      // Execute via the specific local OpenClaw agent
      const result = await this.ocManager.executeAgentTurn(input, {
        agentSlug: agent_slug,
        systemContext,
        timeout: 180000, // 3 min max per job
      });

      if (result.success) {
        // Report completion
        this.ws.send('job_complete', {
          job_id,
          output: { text: result.output, agent_slug, source: 'self_hosted' },
        });
        this.db.updateJob(job_id, 'complete', result.output);
        console.log(`  ✅ Job complete: ${agent_slug} — ${job_id}`);
      } else {
        throw new Error(result.error || 'Agent execution failed');
      }
    } catch (err) {
      this.ws.send('job_failed', { job_id, error: err.message });
      this.db.updateJob(job_id, 'failed', null, err.message);
      console.error(`  ❌ Job failed: ${agent_slug} — ${err.message}`);
    } finally {
      this.activeJobs.delete(job_id);
    }
  }

  _onJobCancel(data) {
    const { job_id } = data;
    const job = this.activeJobs.get(job_id);
    if (job) {
      job.cancelled = true;
      this.activeJobs.delete(job_id);
      this.db.updateJob(job_id, 'cancelled');
      console.log(`  🚫 Job cancelled: ${job_id}`);
    }
  }

  _onConfigSync(data) {
    if (data.config) {
      // Store Bolta API key if provided (for MCP auth)
      if (data.config.api_key) {
        this.config.set('BOLTA_API_KEY', data.config.api_key);
      }
      // Apply to OpenClaw workspace files (SOUL.md, USER.md, TOOLS.md)
      this.ocManager.applyCloudConfig(data.config);
      // Re-configure MCP with new credentials
      this.ocManager._configureMCP();
      console.log('  🔄 Config synced from Bolta Cloud → OpenClaw workspace + MCP updated');
    }
  }

  // --- Helpers ---

  _buildSystemContext(agentSlug, context = {}) {
    const parts = [];

    // Agent role mapping
    const agentRoles = {
      hunter: 'Content Discovery & Trending Topics',
      hype_man: 'Viral Content & Engagement Optimization',
      deep_diver: 'Long-form Research & Analysis',
      guardian: 'Brand Safety & Compliance',
      analyst: 'Performance Analytics & Insights',
      engager: 'Community & Reply Management',
      reply_specialist: 'Smart Replies & Conversations',
      storyteller: 'Narrative & Brand Storytelling',
    };

    const role = agentRoles[agentSlug] || 'General Social Media Agent';
    parts.push(`You are the "${agentSlug}" agent, specializing in ${role}.`);
    parts.push('Execute the task below and return actionable results.');

    if (context.workspace_context) {
      parts.push(`\n## Workspace Context\n${
        typeof context.workspace_context === 'string'
          ? context.workspace_context
          : JSON.stringify(context.workspace_context, null, 2)
      }`);
    }

    if (context.intent) {
      parts.push(`\n## User Intent\n${context.intent}`);
    }

    if (context.account_id) {
      parts.push(`\n## Target Account\nAccount ID: ${context.account_id}`);
    }

    // Add voice profile if available
    const voiceProfile = this.config.get('voice_profile');
    if (voiceProfile) {
      parts.push(`\n## Brand Voice\n${voiceProfile}`);
    }

    return parts.join('\n');
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.connected) {
        this.ws.send('heartbeat', {
          active_jobs: this.activeJobs.size,
          uptime: process.uptime(),
          memory: process.memoryUsage().rss,
          version: '0.1.0',
          agents: Array.from(this.activeJobs.values()).map(j => j.agent_slug),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}
