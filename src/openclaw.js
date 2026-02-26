/**
 * OpenClaw Manager
 *
 * Manages the full OpenClaw lifecycle for Bolta's self-hosted engine.
 *
 * OpenClaw directory structure (using --profile bolta):
 *   ~/.openclaw-bolta/
 *     openclaw.json          — main config (gateway, models, channels, agents, skills, plugins)
 *     agents/
 *       bolta/
 *         agent/
 *           auth.json          — empty {} (keys in auth-profiles)
 *           auth-profiles.json — API key profiles (anthropic, openai, etc.)
 *           models.json        — model overrides per agent
 *         sessions/            — session history (jsonl per session)
 *     workspaces/
 *       bolta/
 *         AGENTS.md            — workspace instructions
 *         SOUL.md              — agent persona (synced from Bolta voice profile)
 *         TOOLS.md             — tool notes (bolta-skills, MCP connection)
 *         USER.md              — user context
 *         HEARTBEAT.md         — heartbeat checklist
 *         skills/              — clawhub-installed skills (bolta-skills-index)
 *         memory/              — agent memory files
 *     credentials/            — channel credentials
 *     memory/                 — LanceDB vector store
 *     logs/                   — gateway logs
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import chalk from 'chalk';

const OPENCLAW_NPM_PACKAGE = 'openclaw';
const BOLTA_SKILLS_CLAWHUB_SLUG = 'MaxFritzhand/bolta-skills-index';
const BOLTA_SKILLS_REPO = 'https://github.com/boltaai/bolta-skills.git';
const BOLTA_MCP_URL = 'https://mcp.bolta.ai/mcp';
const BOLTA_API_URL = 'https://platty.boltathread.com/api/v1';

export class OpenClawManager {
  constructor(config, opts = {}) {
    this.config = config;
    this.verbose = opts.verbose || false;
    this.gatewayProcess = null;
    this.openclawBin = null;

    // Use OpenClaw's --profile system for isolation
    this.profileName = 'bolta';
    this.stateDir = join(
      process.env.HOME || process.env.USERPROFILE || '/tmp',
      `.openclaw-${this.profileName}`
    );
    this.configPath = join(this.stateDir, 'openclaw.json');
    this.workspaceDir = join(this.stateDir, 'workspaces', 'bolta');
    this.agentDir = join(this.stateDir, 'agents', 'bolta');
    this.skillsDir = join(this.workspaceDir, 'skills');
    this.credentialsDir = join(this.stateDir, 'credentials');
  }

  /** Get the env vars needed for all openclaw commands. */
  _env() {
    return {
      ...process.env,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configPath,
    };
  }

  /** Run an openclaw CLI command, return stdout. */
  _exec(args, { timeout = 30000, throwOnError = true } = {}) {
    const cmd = `openclaw --profile ${this.profileName} ${args}`;
    try {
      return execSync(cmd, {
        encoding: 'utf-8',
        env: this._env(),
        timeout,
        stdio: this.verbose ? 'inherit' : 'pipe',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      if (throwOnError) throw err;
      return null;
    }
  }

  // ─── Installation ───────────────────────────────────────────────

  async check() {
    try {
      const version = execSync('openclaw --version 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      this.openclawBin = execSync('which openclaw 2>/dev/null', { encoding: 'utf-8' }).trim();
      return { installed: true, version };
    } catch {
      return { installed: false, version: null };
    }
  }

  async install() {
    if (this.verbose) console.log(chalk.gray('  Installing OpenClaw via npm...'));
    try {
      execSync(`npm install -g ${OPENCLAW_NPM_PACKAGE}`, {
        stdio: this.verbose ? 'inherit' : 'pipe',
        timeout: 120000,
      });
      this.openclawBin = execSync('which openclaw', { encoding: 'utf-8' }).trim();
    } catch (err) {
      throw new Error(`Failed to install OpenClaw: ${err.message}`);
    }
  }

  async update() {
    console.log(chalk.blue('  Updating OpenClaw...'));
    try {
      execSync(`npm update -g ${OPENCLAW_NPM_PACKAGE}`, { stdio: 'inherit', timeout: 120000 });
      console.log(chalk.green('  ✓ OpenClaw updated'));
    } catch (err) {
      console.error(chalk.red(`  ✗ Update failed: ${err.message}`));
    }

    // Update skills
    this._updateSkills();
  }

  // ─── Configuration ──────────────────────────────────────────────

  /**
   * Full configuration of OpenClaw for Bolta use.
   * Creates: config file, agent dirs, workspace files, auth profiles, skills.
   */
  async configure({ port = 18789, anthropicKey = null, openaiKey = null } = {}) {
    // Create directory structure
    for (const dir of [
      this.stateDir,
      this.workspaceDir,
      join(this.workspaceDir, 'memory'),
      this.agentDir,
      join(this.agentDir, 'agent'),
      join(this.agentDir, 'sessions'),
      this.credentialsDir,
      join(this.stateDir, 'memory'),  // LanceDB
      join(this.stateDir, 'cron'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // 1. Write main OpenClaw config
    this._writeMainConfig(port);

    // 2. Write agent auth profiles (API keys)
    this._writeAuthProfiles(anthropicKey, openaiKey);

    // 3. Write agent models config
    this._writeAgentModels();

    // 4. Write workspace files
    this._writeWorkspaceFiles();

    // 5. Install/update bolta-skills
    this._installSkills();

    // 6. Configure channels if tokens are available
    this._configureChannels();

    if (this.verbose) {
      console.log(chalk.gray(`  State dir:  ${this.stateDir}`));
      console.log(chalk.gray(`  Config:     ${this.configPath}`));
      console.log(chalk.gray(`  Workspace:  ${this.workspaceDir}`));
      console.log(chalk.gray(`  Skills:     ${this.skillsDir}`));
    }
  }

  _writeMainConfig(port) {
    const gatewayToken = this._generateToken();

    const config = {
      meta: {
        lastTouchedVersion: '0.1.0-boltaclaw',
        lastTouchedAt: new Date().toISOString(),
      },
      auth: { profiles: {} },
      models: { providers: {} },
      agents: {
        defaults: {
          model: {
            primary: 'anthropic/claude-sonnet-4-5',
          },
          workspace: this.workspaceDir,
          contextPruning: {
            mode: 'cache-ttl',
            ttl: '1h',
          },
          compaction: {
            mode: 'safeguard',
          },
          heartbeat: {
            every: '30m',
          },
          maxConcurrent: 4,
          subagents: {
            maxConcurrent: 8,
          },
        },
        list: [
          {
            id: 'bolta',
            model: {
              primary: 'anthropic/claude-sonnet-4-5',
            },
          },
        ],
      },
      messages: {
        ackReactionScope: 'group-mentions',
      },
      commands: {
        native: 'auto',
        nativeSkills: 'auto',
        restart: true,
      },
      channels: {},
      gateway: {
        port,
        mode: 'local',
        bind: 'loopback',
        auth: {
          mode: 'token',
          token: gatewayToken,
        },
        trustedProxies: ['127.0.0.1'],
      },
      skills: {
        entries: {},
      },
      plugins: {
        slots: {
          memory: 'memory-lancedb',
        },
        entries: {
          'memory-lancedb': {
            enabled: true,
          },
        },
      },
    };

    // Store gateway token for bridge access
    this.config.set('gateway_token', gatewayToken);
    this.config.set('gateway_port', String(port));

    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  _writeAuthProfiles(anthropicKey, openaiKey) {
    // OpenClaw stores API keys in agents/<id>/agent/auth-profiles.json
    const authProfilesPath = join(this.agentDir, 'agent', 'auth-profiles.json');

    // Read existing or create new
    let profiles = { profiles: {}, lastGood: {}, usageStats: {} };
    try {
      profiles = JSON.parse(readFileSync(authProfilesPath, 'utf-8'));
    } catch { /* fresh install */ }

    // Anthropic key (BYOK)
    const key = anthropicKey || this.config.get('ANTHROPIC_API_KEY');
    if (key) {
      profiles.profiles['anthropic:bolta'] = {
        type: 'api_key',
        provider: 'anthropic',
        key,
      };
      profiles.lastGood['anthropic'] = 'anthropic:bolta';
    }

    // OpenAI key (optional, for embeddings/whisper/dalle)
    const oaiKey = openaiKey || this.config.get('OPENAI_API_KEY');
    if (oaiKey) {
      profiles.profiles['openai:bolta'] = {
        type: 'api_key',
        provider: 'openai',
        key: oaiKey,
      };
      profiles.lastGood['openai'] = 'openai:bolta';
    }

    writeFileSync(authProfilesPath, JSON.stringify(profiles, null, 2));

    // Also write auth.json (must exist, can be empty)
    const authPath = join(this.agentDir, 'agent', 'auth.json');
    if (!existsSync(authPath)) {
      writeFileSync(authPath, '{}');
    }
  }

  _writeAgentModels() {
    // Agent-level model overrides
    const modelsPath = join(this.agentDir, 'agent', 'models.json');
    const models = { providers: {} };
    writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  }

  _configureChannels() {
    // Read current config
    let config;
    try {
      config = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch { return; }

    let changed = false;

    // Telegram
    const tgToken = this.config.get('TELEGRAM_BOT_TOKEN');
    if (tgToken) {
      config.channels.telegram = {
        botToken: tgToken,
        dmPolicy: 'allowlist',
        groupPolicy: 'allowlist',
        streaming: true,
        allowFrom: [],
      };

      // If user provided their Telegram ID, add to allowlist
      const tgUserId = this.config.get('TELEGRAM_USER_ID');
      if (tgUserId) {
        config.channels.telegram.allowFrom = [tgUserId];
      }

      // Enable telegram plugin
      if (!config.plugins) config.plugins = { slots: {}, entries: {} };
      config.plugins.entries.telegram = { enabled: true };
      changed = true;
    }

    // Slack
    const slackToken = this.config.get('SLACK_BOT_TOKEN');
    if (slackToken) {
      config.channels.slack = {
        botToken: slackToken,
        appToken: this.config.get('SLACK_APP_TOKEN') || '',
      };
      changed = true;
    }

    if (changed) {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    }
  }

  // ─── Workspace Files ────────────────────────────────────────────

  _writeWorkspaceFiles() {
    const workspaceId = this.config.get('workspace_id') || 'pending';
    const voiceProfile = this.config.get('voice_profile') || '';

    const writeIfMissing = (filename, content) => {
      const path = join(this.workspaceDir, filename);
      if (!existsSync(path)) writeFileSync(path, content);
    };

    // Update SOUL.md always (voice profile may change from cloud)
    writeFileSync(join(this.workspaceDir, 'SOUL.md'), `# SOUL.md — Bolta Agent

**Name:** Bolta Agent
**Role:** AI Social Media Manager

## Personality
You are a professional, creative AI social media agent running on the user's own machine via OpenClaw.
You help create, schedule, refine, and manage social media content across platforms.

## Voice
${voiceProfile || 'Adapt to the brand voice configured in the workspace. Be professional yet approachable. Write engaging content that resonates with the target audience.'}

## What You Do
- Draft social media posts (Twitter/X, LinkedIn, Instagram, Facebook, Reddit, etc.)
- Research trending topics and content ideas
- Analyze post performance and suggest improvements
- Reply to comments and engage with audience
- Schedule content on optimal posting times
- Maintain brand voice consistency

## Rules
- Never publish without explicit approval unless in autopilot mode
- Always offer alternatives and refinements for draft content
- Flag any content that could be controversial or off-brand
- Use the brand's tone, vocabulary, and style consistently
- Report results back to the Bolta dashboard
`);

    writeIfMissing('AGENTS.md', `# AGENTS.md — Bolta Workspace

## Identity
- Running on self-hosted OpenClaw engine
- Workspace ID: ${workspaceId}
- Connected to Bolta Cloud via secure WebSocket bridge

## Tools
Available tools come from multiple sources:

### Bolta Skills (local)
Installed via ClawHub at ./skills/. These contain skill docs and scripts for:
- Content creation and drafting
- Social media posting and scheduling
- Analytics and performance tracking
- Audience engagement and replies
- Brand voice training

### Bolta MCP (cloud)
71 tools at ${BOLTA_MCP_URL}. Major categories:
- \`bolta_draft_post\` — Draft content for any platform
- \`bolta_schedule_post\` — Schedule posts for optimal times
- \`bolta_analyze_post\` — Get performance analytics
- \`bolta_remember\` / \`bolta_recall\` — Persistent memory
- \`bolta_get_inbox\` — Check pending content
- \`bolta_approve_post\` — Approve drafts for publishing

### Bolta API
REST API at ${BOLTA_API_URL}. Used for workspace operations,
account management, and direct integrations.

## Memory
- Write to memory/ for persistent context across sessions
- Use bolta_remember/bolta_recall for structured memory
- Daily notes in memory/YYYY-MM-DD.md

## Safety
- Never publish without approval (unless autopilot mode)
- Keep API keys local — never log or transmit them
- Report errors back to Bolta dashboard via the bridge
`);

    writeIfMissing('USER.md', `# USER.md — About the Human

- **Timezone:** (set from Bolta dashboard)
- **Notes:** Configure your profile in the Bolta dashboard for personalized agent behavior.
`);

    writeIfMissing('TOOLS.md', `# TOOLS.md — Tool Notes

## Bolta MCP
- **URL:** ${BOLTA_MCP_URL}
- **Protocol:** SSE (StreamableHTTP)
- **Tools:** 71 (content, scheduling, analytics, memory, inbox, accounts)

## Bolta API
- **Base URL:** ${BOLTA_API_URL}
- **Auth:** Workspace API key (set in dashboard)

## Bolta Skills
- **Location:** ./skills/ (ClawHub installed)
- **Source:** ${BOLTA_SKILLS_CLAWHUB_SLUG}
`);

    writeIfMissing('HEARTBEAT.md', `# HEARTBEAT.md

## Checks
- [ ] Any pending content in Bolta Inbox?
- [ ] Any scheduled posts coming up in next 2 hours?
- [ ] Any failed posts or errors to address?
- [ ] Any new comments/replies to handle?

## Proactive Work
- Check for trending topics relevant to the brand
- Review recent post performance
- Suggest content ideas for upcoming week
- Update memory with any new brand guidelines

## Quiet Hours
- Respect the user's timezone quiet hours
- Only alert for urgent issues (failed scheduled posts, etc.)
- Reply HEARTBEAT_OK if nothing needs attention
`);
  }

  // ─── Skills ─────────────────────────────────────────────────────

  _installSkills() {
    mkdirSync(this.skillsDir, { recursive: true });

    // Try clawhub install first (preferred — gets updates)
    try {
      this._exec(
        `config set skills.entries.bolta-skills.enabled true`,
        { throwOnError: false }
      );

      // Install via clawhub into workspace skills dir
      execSync(
        `clawhub install ${BOLTA_SKILLS_CLAWHUB_SLUG} --dir "${this.skillsDir}" --no-input 2>/dev/null`,
        { timeout: 60000, stdio: 'pipe' }
      );
      if (this.verbose) console.log(chalk.green('  ✓ bolta-skills installed via ClawHub'));
      return;
    } catch {
      // ClawHub not available or install failed
    }

    // Fallback: git clone
    const gitSkillsDir = join(this.config.dataDir, 'skills-git');
    try {
      if (existsSync(join(gitSkillsDir, '.git'))) {
        execSync(`cd "${gitSkillsDir}" && git pull --quiet`, { timeout: 30000, stdio: 'pipe' });
      } else {
        execSync(`git clone --depth 1 ${BOLTA_SKILLS_REPO} "${gitSkillsDir}"`, {
          timeout: 60000,
          stdio: 'pipe',
        });
      }
      if (this.verbose) console.log(chalk.green('  ✓ bolta-skills cloned from GitHub'));
    } catch {
      if (this.verbose) console.log(chalk.yellow('  ⚠ Could not install bolta-skills'));
    }
  }

  _updateSkills() {
    console.log(chalk.blue('  Updating bolta-skills...'));
    try {
      execSync(
        `clawhub update ${BOLTA_SKILLS_CLAWHUB_SLUG} --dir "${this.skillsDir}" --no-input 2>/dev/null`,
        { timeout: 60000, stdio: 'pipe' }
      );
      console.log(chalk.green('  ✓ bolta-skills updated'));
    } catch {
      // Try git fallback
      const gitSkillsDir = join(this.config.dataDir, 'skills-git');
      if (existsSync(join(gitSkillsDir, '.git'))) {
        try {
          execSync(`cd "${gitSkillsDir}" && git pull --quiet`, { timeout: 30000, stdio: 'pipe' });
          console.log(chalk.green('  ✓ bolta-skills updated (git)'));
        } catch {
          console.log(chalk.yellow('  ⚠ Could not update bolta-skills'));
        }
      }
    }
  }

  // ─── Gateway Lifecycle ──────────────────────────────────────────

  async startGateway() {
    // Check if already running
    const status = await this.gatewayStatus();
    if (status.running) {
      if (this.verbose) console.log(chalk.gray('  Gateway already running'));
      return;
    }

    return new Promise((resolve, reject) => {
      // Use openclaw gateway run (foreground) in a detached child
      this.gatewayProcess = spawn(
        'openclaw',
        ['--profile', this.profileName, 'gateway', 'run', '--force'],
        {
          env: this._env(),
          stdio: this.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          detached: true,
        }
      );

      let stderr = '';
      if (!this.verbose && this.gatewayProcess.stderr) {
        this.gatewayProcess.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
      }

      // Wait for gateway to be ready (poll health)
      let attempts = 0;
      const maxAttempts = 20;
      const pollInterval = setInterval(async () => {
        attempts++;
        const s = await this.gatewayStatus();
        if (s.running) {
          clearInterval(pollInterval);
          resolve();
        } else if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          reject(new Error(`Gateway failed to start after ${maxAttempts} attempts. ${stderr}`));
        }
      }, 500);

      this.gatewayProcess.on('error', (err) => {
        clearInterval(pollInterval);
        reject(new Error(`Gateway process error: ${err.message}`));
      });

      this.gatewayProcess.on('exit', (code) => {
        if (code && code !== 0) {
          clearInterval(pollInterval);
          reject(new Error(`Gateway exited with code ${code}. ${stderr}`));
        }
      });

      // Unref so main process can exit
      this.gatewayProcess.unref();
    });
  }

  async stopGateway() {
    if (this.gatewayProcess) {
      this.gatewayProcess.kill('SIGTERM');
      this.gatewayProcess = null;
    }

    // Also try via service
    try {
      this._exec('gateway stop', { timeout: 5000, throwOnError: false });
    } catch { /* already stopped */ }
  }

  async gatewayStatus() {
    try {
      const port = this.config.get('gateway_port') || '18789';
      const token = this.config.get('gateway_token') || '';

      const result = execSync(
        `openclaw --profile ${this.profileName} gateway call health --token "${token}" --json 2>/dev/null`,
        {
          encoding: 'utf-8',
          env: this._env(),
          timeout: 5000,
        }
      );

      const data = JSON.parse(result);
      return { running: data?.ok === true, data };
    } catch {
      return { running: false };
    }
  }

  async tailLogs(follow = false) {
    const args = ['--profile', this.profileName, 'logs'];
    if (follow) args.push('-f');

    spawn('openclaw', args, { env: this._env(), stdio: 'inherit' });
  }

  // ─── Agent Execution ────────────────────────────────────────────

  /**
   * Execute an agent turn via the OpenClaw gateway.
   *
   * Uses `openclaw agent` which routes through the running gateway,
   * giving full access to tools, memory, skills, channels, etc.
   */
  async executeAgentTurn(message, { systemContext = '', timeout = 180000 } = {}) {
    try {
      const token = this.config.get('gateway_token') || '';

      // Build the agent command
      // --local would bypass gateway; we want gateway for full tool access
      const args = [
        '--profile', this.profileName,
        'agent',
        '--agent', 'bolta',
        '--message', message,
        '--json',
        '--timeout', String(Math.floor(timeout / 1000)),
      ];

      const cmd = 'openclaw ' + args.map(a => {
        // Escape the message properly
        if (a.includes(' ') || a.includes('"') || a.includes("'") || a.includes('\n')) {
          return JSON.stringify(a);
        }
        return a;
      }).join(' ');

      const result = execSync(cmd, {
        encoding: 'utf-8',
        env: {
          ...this._env(),
          OPENCLAW_GATEWAY_TOKEN: token,
          // Inject system context as an env var the agent can read
          BOLTA_SYSTEM_CONTEXT: systemContext,
        },
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      // Parse JSON output
      try {
        const data = JSON.parse(result);
        return {
          success: true,
          output: data.reply || data.content || result.trim(),
          raw: data,
        };
      } catch {
        return { success: true, output: result.trim() };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── Config Sync (from Bolta Cloud) ─────────────────────────────

  /**
   * Apply config pushed from Bolta Cloud.
   * Called by the Bridge when it receives a config_sync event.
   */
  applyCloudConfig(cloudConfig) {
    if (!cloudConfig) return;

    // Update voice profile → rewrite SOUL.md
    if (cloudConfig.voice_profile) {
      this.config.set('voice_profile', cloudConfig.voice_profile);
      // Rewrite workspace files with new voice
      this._writeWorkspaceFiles();
    }

    // Update agent presets
    if (cloudConfig.agents) {
      this.config.set('cloud_agents', JSON.stringify(cloudConfig.agents));
    }

    // Update user context → rewrite USER.md
    if (cloudConfig.user) {
      const userMd = `# USER.md — About the Human

- **Name:** ${cloudConfig.user.name || '(not set)'}
- **Timezone:** ${cloudConfig.user.timezone || '(not set)'}
- **Notes:** ${cloudConfig.user.notes || 'Configure your profile in the Bolta dashboard.'}
`;
      writeFileSync(join(this.workspaceDir, 'USER.md'), userMd);
    }

    // Update social accounts context → append to TOOLS.md
    if (cloudConfig.accounts) {
      const accountsSection = `
## Connected Social Accounts
${cloudConfig.accounts.map(a => `- **${a.platform}**: ${a.username || a.id} (${a.status || 'active'})`).join('\n')}
`;
      // Append to TOOLS.md
      try {
        let tools = readFileSync(join(this.workspaceDir, 'TOOLS.md'), 'utf-8');
        // Replace existing accounts section or append
        if (tools.includes('## Connected Social Accounts')) {
          tools = tools.replace(/## Connected Social Accounts[\s\S]*?(?=\n## |\n$|$)/, accountsSection.trim());
        } else {
          tools += '\n' + accountsSection;
        }
        writeFileSync(join(this.workspaceDir, 'TOOLS.md'), tools);
      } catch { /* workspace not ready yet */ }
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────

  _generateToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  _readConfig() {
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  getGatewayUrl() {
    const port = this.config.get('gateway_port') || '18789';
    return `ws://127.0.0.1:${port}`;
  }
}
