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
import { resolveProviderConfig } from './llm.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const BOLTA_WS_URL = process.env.BOLTA_WS_URL || 'wss://platty.boltathread.com/ws/runner/';
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

    // Wait for handshake before resolving connect() — ensures runner_key is saved
    const handshakePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Handshake timeout (30s)')), 30000);
      this.ws.on('handshake_complete', (data) => {
        clearTimeout(timeout);
        this._onHandshake(data);
        resolve(data);
      });
      this.ws.on('error', (data) => {
        clearTimeout(timeout);
        reject(new Error(data.message || 'Auth failed'));
      });
    });

    // Register other message handlers
    this.ws.on('job_dispatch', (data) => this._onJobDispatch(data));
    this.ws.on('job_cancel', (data) => this._onJobCancel(data));
    this.ws.on('config_sync', (data) => this._onConfigSync(data));
    this.ws.on('agent_bootstrap_sync', (data) => this._onAgentBootstrapSync(data));
    this.ws.on('register_workspace_result', (data) => this._onRegisterWorkspaceResult(data));
    this.ws.on('ping', () => this.ws.send('pong', {}));
    this.ws.on('sleep', (data) => this._onSleep(data));
    this.ws.on('telegram_reply', (data) => this._onTelegramReply(data));

    // Reconnect handler — use persistent runner_key (install token is burned after first handshake)
    this.ws.on('reconnected', () => {
      const runnerKey = this.config.get('runner_key');
      if (runnerKey) {
        console.log(`  🔄 Reconnecting with runner_key: ${runnerKey.slice(0, 12)}...`);
        this.ws.send('auth', { token: runnerKey });
      } else {
        // Install token is burned after first use — cannot reconnect without runner_key
        console.error('  ❌ No runner_key saved. The install token was already used.');
        console.error('  ❌ Generate a new token from Bolta dashboard → Settings → Self-Hosted');
        console.error('  ❌ Then run: boltaclaw start --token=workspace_live_...');
      }
    });

    await this.ws.connect();

    // Small delay to ensure WS is fully ready before sending auth
    await new Promise(r => setTimeout(r, 100));

    // Authenticate (consumer expects auth as first message)
    console.log('  🔑 Sending auth...');
    this.ws.send('auth', { token });
    console.log('  🔑 Auth sent, waiting for handshake...');

    // Wait for handshake to complete — ensures runner_key is persisted before proceeding
    await handshakePromise;

    this._startHeartbeat();
  }

  async disconnect() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) await this.ws.close();
  }

  // --- Event Handlers ---

  _onHandshake(data) {
    console.log('  📨 Handshake data keys:', Object.keys(data));
    // Install token → persistent runner key swap
    if (data.runner_key) {
      try {
        this.config.set('runner_key', data.runner_key);
        this.config.delete('install_token'); // Burn the install token
        // Verify it was saved
        const saved = this.config.get('runner_key');
        console.log(`  🔑 Runner key saved: ${data.runner_key.slice(0, 12)}... (verified: ${saved ? 'yes' : 'NO'})`);
      } catch (err) {
        console.error(`  ❌ Failed to save runner_key: ${err.message}`);
      }
    } else {
      console.log('  ⚠ No runner_key in handshake response. Data:', JSON.stringify(data).slice(0, 200));
    }
    if (data.workspace_id) {
      this.config.set('workspace_id', data.workspace_id);
    }
    // Multi-tenant: store all workspace IDs
    if (data.workspaces && Array.isArray(data.workspaces)) {
      this.workspaceIds = data.workspaces.map(w => w.id);
      this.config.set('workspace_ids', JSON.stringify(this.workspaceIds));
      console.log(`  🏢 Serving ${this.workspaceIds.length} workspace(s): ${this.workspaceIds.map(id => id.slice(0, 8)).join(', ')}`);
    } else {
      this.workspaceIds = [data.workspace_id];
    }
    // Store Bolta API key for MCP
    if (data.api_key) {
      this.config.set('BOLTA_API_KEY', data.api_key);
    }
    // Sync any config from cloud
    if (data.config) {
      this.ocManager.applyCloudConfig(data.config);
    }
    // Multi-tenant: apply configs for all workspaces
    if (data.workspace_configs) {
      for (const [wsId, wsConfig] of Object.entries(data.workspace_configs)) {
        this.ocManager.applyCloudConfig(wsConfig, wsId);
      }
    }
    console.log(`  ✅ Handshake complete — workspace: ${data.workspace_id}`);
  }

  async _onJobDispatch(data) {
    const { job_id, run_id, agent_slug, input, context, workspace_id } = data;
    const targetWorkspace = workspace_id || this.config.get('workspace_id');

    console.log(`  📥 Job received: ${agent_slug} — ${job_id} (workspace: ${targetWorkspace.slice(0, 8)}...)`);

    // Store job locally
    this.db.createJob(job_id, targetWorkspace, agent_slug, input);
    this.activeJobs.set(job_id, { status: 'running', started: Date.now(), agent_slug });

    // Report progress: starting
    this.ws.send('job_progress', {
      job_id,
      event: { type: 'status', message: `${agent_slug} is thinking...` },
    });

    // Snapshot memory before run (for diff after completion)
    const memoryBefore = this.ocManager.getAgentMemorySnapshot(agent_slug);

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

        // Sync memory changes back to server
        this._syncAgentSelfUpdates(agent_slug, memoryBefore);
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

  async _onTelegramReply(data) {
    const { chat_id, text } = data;
    if (!chat_id || !text) return;

    if (this.telegramWebhook) {
      try {
        await this.telegramWebhook.sendReply(chat_id, text);
        console.log(`  📤 Telegram reply sent to chat ${chat_id} (${text.length} chars)`);
      } catch (err) {
        console.error(`  ❌ Telegram reply failed: ${err.message}`);
      }
    } else {
      console.warn('  ⚠ Telegram reply received but no webhook instance available');
    }
  }

  _onSleep(data) {
    const reason = data?.reason || 'idle';
    console.log(`  💤 Sleep command received (reason: ${reason})`);

    // Don't sleep if there are active jobs
    if (this.activeJobs.size > 0) {
      console.log(`  ⏳ Ignoring sleep — ${this.activeJobs.size} job(s) still active`);
      return;
    }

    // Trigger graceful shutdown via callback (set by cli.js)
    if (this.onSleepCallback) {
      this.onSleepCallback(reason);
    } else {
      // Fallback: exit directly
      process.exit(0);
    }
  }

  _onConfigSync(data) {
    if (data.config) {
      // Multi-tenant: handle workspace registration from server
      if (data.config.register_workspace) {
        const { workspace_id, token } = data.config.register_workspace;
        console.log(`  🏢 Registering new workspace: ${workspace_id.slice(0, 8)}...`);
        this.ws.send('register_workspace', { token });
        return;
      }

      // Store Bolta API key if provided (for MCP auth)
      if (data.config.api_key) {
        this.config.set('BOLTA_API_KEY', data.config.api_key);
      }

      // Store LLM API key and provider if provided
      if (data.config.llm_api_key && data.config.llm_provider) {
        const { envKey, model, provider } = resolveProviderConfig({
          provider: data.config.llm_provider,
          model: data.config.llm_model,
        });
        if (envKey) {
          this.config.set(envKey, data.config.llm_api_key);
          this.config.set('MODEL_PRIMARY', model);
          const redacted = data.config.llm_api_key.substring(0, 8) + '...';
          console.log(`  🔑 LLM API key stored: ${envKey} = ${redacted} (provider: ${provider}, model: ${model})`);
        }
      }

      // Store Telegram bot token if provided
      if (data.config.telegram_bot_token) {
        const telegramDisabled = ['1', 'true', 'yes'].includes(
          String(this.config.get('TELEGRAM_DISABLED') || '').toLowerCase()
        );
        if (!telegramDisabled) {
          this.config.set('TELEGRAM_BOT_TOKEN', data.config.telegram_bot_token);
          const redacted = data.config.telegram_bot_token.substring(0, 8) + '...';
          console.log(`  🔑 Telegram bot token stored: ${redacted}`);
        } else {
          console.log('  ⏭ Telegram token ignored (TELEGRAM_DISABLED=true)');
        }
      }

      // Apply to OpenClaw workspace files (SOUL.md, USER.md, TOOLS.md)
      this.ocManager.applyCloudConfig(data.config);
      // Re-configure MCP with new credentials
      this.ocManager._configureMCP();
      // Re-apply channel config (Telegram, Slack) with any new tokens from cloud
      this.ocManager.configureChannels();
      console.log('  🔄 Config synced from Bolta Cloud → OpenClaw workspace + MCP updated');
    }
  }

  _onRegisterWorkspaceResult(data) {
    if (data.success) {
      // Add to local workspace list
      if (!this.workspaceIds) this.workspaceIds = [];
      if (!this.workspaceIds.includes(data.workspace_id)) {
        this.workspaceIds.push(data.workspace_id);
        this.config.set('workspace_ids', JSON.stringify(this.workspaceIds));
      }
      // Apply workspace config if provided
      if (data.config) {
        this.ocManager.applyCloudConfig(data.config, data.workspace_id);
      }
      console.log(`  ✅ Workspace registered: ${data.workspace_id.slice(0, 8)}... (${data.role}) — total: ${this.workspaceIds.length}`);
    } else {
      console.error(`  ❌ Workspace registration failed: ${data.error}`);
    }
  }

  _onAgentBootstrapSync(data) {
    if (data.slug && data.bootstrap) {
      this.ocManager.applyAgentBootstrap(data.slug, data.bootstrap);
      console.log(`  🔄 Bootstrap synced for agent: ${data.slug}`);
    }
  }

  async _syncAgentSelfUpdates(agentSlug, memoryBefore) {
    try {
      const memoryUpdates = this.ocManager.diffAgentMemory(agentSlug, memoryBefore);
      if (memoryUpdates.length === 0) return;

      const apiKey = this.config.get('BOLTA_API_KEY');
      const workspaceId = this.config.get('workspace_id');
      if (!apiKey || !workspaceId) return;

      // We need the agent ID, but we only have the slug
      // Send via WebSocket instead — let server resolve slug → id
      this.ws.send('agent_self_update', {
        agent_slug: agentSlug,
        memory_updates: memoryUpdates,
      });

      console.log(`  🧠 Synced ${memoryUpdates.length} memory update(s) for ${agentSlug}`);
    } catch (err) {
      console.error(`  ⚠ Memory sync failed for ${agentSlug}: ${err.message}`);
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

    // Try to read server-generated SOUL.md first, fallback to role map
    let soulContent = null;
    try {
      const soulPath = join(this.ocManager.workspaceDir, 'agents', agentSlug, 'SOUL.md');
      soulContent = readFileSync(soulPath, 'utf-8');
    } catch { /* file doesn't exist yet */ }

    if (soulContent) {
      parts.push(soulContent);
      parts.push('\nExecute the task below and return actionable results.');
    } else {
      const role = agentRoles[agentSlug] || 'General Social Media Agent';
      parts.push(`You are the "${agentSlug}" agent, specializing in ${role}.`);
      parts.push('Execute the task below and return actionable results.');
    }

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
