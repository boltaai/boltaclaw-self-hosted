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
import { AGENT_PRESETS, getAgentIds, buildCronJobs } from './agents.js';

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
    const bin = this.openclawBin || 'openclaw';
    const cmd = `"${bin}" --profile ${this.profileName} ${args}`;
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
    // Check local install first, then global
    const localBin = join(this.stateDir, 'node_modules', '.bin', 'openclaw');
    const candidates = [
      localBin,
      'openclaw', // global PATH
    ];

    for (const bin of candidates) {
      try {
        const version = execSync(`"${bin}" --version 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        this.openclawBin = bin === 'openclaw'
          ? execSync('which openclaw 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim()
          : bin;
        return { installed: true, version };
      } catch { /* try next */ }
    }

    return { installed: false, version: null };
  }

  async install() {
    // Install OpenClaw locally into the state dir — no sudo, no global
    console.log(chalk.gray('  Installing OpenClaw locally into ' + this.stateDir + '...'));
    mkdirSync(this.stateDir, { recursive: true });

    // Create a package.json if missing (needed for local npm install)
    const pkgPath = join(this.stateDir, 'package.json');
    if (!existsSync(pkgPath)) {
      writeFileSync(pkgPath, JSON.stringify({ name: 'openclaw-bolta', private: true }, null, 2));
    }

    try {
      // Use npm install with explicit save to ensure it gets added
      execSync(`npm install --save ${OPENCLAW_NPM_PACKAGE}@latest`, {
        cwd: this.stateDir,
        stdio: 'inherit',
        timeout: 120000,
      });
    } catch (err) {
      throw new Error(`npm install openclaw failed: ${err.message}`);
    }

    // Find the binary
    const localBin = join(this.stateDir, 'node_modules', '.bin', 'openclaw');
    if (existsSync(localBin)) {
      this.openclawBin = localBin;
      return;
    }

    // Fallback: check if openclaw.mjs exists and create a wrapper
    const ocMjs = join(this.stateDir, 'node_modules', 'openclaw', 'openclaw.mjs');
    if (existsSync(ocMjs)) {
      this.openclawBin = ocMjs;
      return;
    }

    throw new Error(`OpenClaw installed but binary not found. Checked:\n  ${localBin}\n  ${ocMjs}`);
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
    // Create directory structure — one workspace shared by all agents,
    // but each agent gets its own agent dir for auth/sessions
    const dirs = [
      this.stateDir,
      this.workspaceDir,
      join(this.workspaceDir, 'memory'),
      this.credentialsDir,
      join(this.stateDir, 'memory'),  // LanceDB
      join(this.stateDir, 'cron'),
    ];

    // Create agent dirs for all 8 agents
    for (const slug of getAgentIds()) {
      const agentBase = join(this.stateDir, 'agents', slug);
      dirs.push(agentBase, join(agentBase, 'agent'), join(agentBase, 'sessions'));
    }

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // 1. Write main OpenClaw config (all 8 agents registered)
    this._writeMainConfig(port);

    // 2. Write auth profiles for each agent (shared API keys)
    for (const slug of getAgentIds()) {
      this._writeAuthProfiles(anthropicKey, openaiKey, slug);
    }

    // 3. Write each agent's SOUL.md and HEARTBEAT.md into workspace
    this._writeAgentWorkspaceFiles();

    // 4. Write shared workspace files (AGENTS.md, TOOLS.md, USER.md)
    this._writeWorkspaceFiles();

    // 5. Install/update bolta-skills
    this._installSkills();

    // 6. Configure Bolta MCP (71 tools via mcporter)
    this._configureMCP();

    // 7. Configure channels (Telegram, Slack)
    this._configureChannels();

    // 8. Configure cron schedules for all agents
    this._configureCronJobs();

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
        list: getAgentIds().map(slug => ({
          id: slug,
          model: { primary: 'anthropic/claude-sonnet-4-5' },
        })),
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
        slots: {},
        entries: {},
      },
    };

    // Store gateway token for bridge access
    this.config.set('gateway_token', gatewayToken);
    this.config.set('gateway_port', String(port));

    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  _writeAuthProfiles(anthropicKey, openaiKey, agentSlug = null) {
    // OpenClaw stores API keys in agents/<id>/agent/auth-profiles.json
    const agentBase = agentSlug
      ? join(this.stateDir, 'agents', agentSlug)
      : this.agentDir;
    const authProfilesPath = join(agentBase, 'agent', 'auth-profiles.json');

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
    const authPath = join(agentBase, 'agent', 'auth.json');
    if (!existsSync(authPath)) {
      writeFileSync(authPath, '{}');
    }
  }

  // ─── Per-Agent Workspace Files ────────────────────────────────

  _writeAgentWorkspaceFiles() {
    // Each agent gets their SOUL.md and HEARTBEAT.md in the shared workspace
    // under agent-specific subdirs, plus a models.json in their agent dir
    for (const [slug, preset] of Object.entries(AGENT_PRESETS)) {
      // Write SOUL.md into workspace/agents/<slug>/
      const agentWorkspace = join(this.workspaceDir, 'agents', slug);
      mkdirSync(agentWorkspace, { recursive: true });
      writeFileSync(join(agentWorkspace, 'SOUL.md'), preset.soul);
      writeFileSync(join(agentWorkspace, 'HEARTBEAT.md'), preset.heartbeat);

      // Write models.json in agent dir
      const modelsPath = join(this.stateDir, 'agents', slug, 'agent', 'models.json');
      if (!existsSync(modelsPath)) {
        writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));
      }
    }

    if (this.verbose) {
      console.log(chalk.green(`  ✓ ${Object.keys(AGENT_PRESETS).length} agents configured with SOULs and heartbeats`));
    }
  }

  // ─── MCP Configuration ───────────────────────────────────────

  _configureMCP() {
    // mcporter connects OpenClaw agents to Bolta's 71 MCP tools
    // Config lives in the workspace at config/mcporter.json
    const mcpConfigDir = join(this.workspaceDir, 'config');
    mkdirSync(mcpConfigDir, { recursive: true });

    const mcpConfigPath = join(mcpConfigDir, 'mcporter.json');

    // Build the Bolta API key header for authenticated MCP calls
    const boltaApiKey = this.config.get('BOLTA_API_KEY') || '';
    const workspaceId = this.config.get('workspace_id') || '';

    const mcpConfig = {
      servers: {
        bolta: {
          url: BOLTA_MCP_URL,
          transport: 'http',
          description: 'Bolta AI — 71 social media agent tools (drafting, scheduling, analytics, memory, inbox)',
          headers: {},
        },
      },
    };

    // Add auth headers if we have API key
    if (boltaApiKey) {
      mcpConfig.servers.bolta.headers['X-API-Key'] = boltaApiKey;
    }
    if (workspaceId) {
      mcpConfig.servers.bolta.headers['X-Workspace-Id'] = workspaceId;
    }

    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Enable mcporter skill in OpenClaw config
    let config;
    try {
      config = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch { return; }

    if (!config.skills) config.skills = { entries: {} };
    config.skills.entries.mcporter = { enabled: true };
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));

    // Install mcporter globally if not present
    try {
      execSync('which mcporter 2>/dev/null', { encoding: 'utf-8' });
    } catch {
      try {
        execSync('npm install -g mcporter', {
          stdio: this.verbose ? 'inherit' : 'pipe',
          timeout: 60000,
        });
        if (this.verbose) console.log(chalk.green('  ✓ mcporter installed'));
      } catch {
        if (this.verbose) console.log(chalk.yellow('  ⚠ Could not install mcporter — MCP tools may not be available'));
      }
    }

    if (this.verbose) {
      console.log(chalk.green(`  ✓ Bolta MCP configured (${BOLTA_MCP_URL})`));
    }
  }

  _configureChannels() {
    // Read current config
    let config;
    try {
      config = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch { return; }

    let changed = false;

    // Telegram — fully pre-configured for immediate use
    const tgToken = this.config.get('TELEGRAM_BOT_TOKEN');
    if (tgToken) {
      const allowFrom = [];
      // Add user's Telegram ID to allowlist
      const tgUserId = this.config.get('TELEGRAM_USER_ID');
      if (tgUserId) allowFrom.push(tgUserId);

      config.channels.telegram = {
        botToken: tgToken,
        dmPolicy: allowFrom.length > 0 ? 'allowlist' : 'open',
        groupPolicy: 'allowlist',
        streaming: true,
        allowFrom,
      };

      // Enable telegram plugin
      if (!config.plugins) config.plugins = { slots: {}, entries: {} };
      config.plugins.entries.telegram = { enabled: true };
      changed = true;

      // Write Telegram credentials for OpenClaw's native channel system
      const tgCreds = join(this.credentialsDir, 'telegram-allowFrom.json');
      if (allowFrom.length > 0 && !existsSync(tgCreds)) {
        writeFileSync(tgCreds, JSON.stringify(allowFrom, null, 2));
      }

      if (this.verbose) {
        console.log(chalk.green(`  ✓ Telegram configured${allowFrom.length ? ` (allowlist: ${allowFrom.join(', ')})` : ' (open DMs)'}`));
      }
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

  // ─── Cron Schedules ──────────────────────────────────────────────

  _configureCronJobs() {
    // Build cron jobs from agent presets and write to cron dir
    const timezone = this.config.get('timezone') || 'America/New_York';
    const cronJobs = buildCronJobs(timezone);

    // OpenClaw stores cron jobs in the cron/ directory as individual JSON files
    const cronDir = join(this.stateDir, 'cron');
    mkdirSync(cronDir, { recursive: true });

    // Write a manifest that OpenClaw reads on startup
    const cronConfigPath = join(cronDir, 'jobs.json');
    const existingJobs = [];
    try {
      const existing = JSON.parse(readFileSync(cronConfigPath, 'utf-8'));
      if (Array.isArray(existing)) existingJobs.push(...existing);
    } catch { /* fresh install */ }

    // Merge: keep user-created jobs, replace preset-generated ones
    const userJobs = existingJobs.filter(j => !j._preset);
    const presetJobs = cronJobs.map(j => ({ ...j, _preset: true }));

    writeFileSync(cronConfigPath, JSON.stringify([...userJobs, ...presetJobs], null, 2));

    if (this.verbose) {
      console.log(chalk.green(`  ✓ ${cronJobs.length} cron jobs configured for ${Object.keys(AGENT_PRESETS).length} agents`));
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

    // Build agent roster for AGENTS.md
    const agentRoster = Object.entries(AGENT_PRESETS).map(([slug, p]) =>
      `- **${p.emoji} ${p.name}** (\`${slug}\`) — ${p.tagline}`
    ).join('\n');

    writeIfMissing('AGENTS.md', `# AGENTS.md — Bolta Workspace

## Identity
- Running on self-hosted OpenClaw engine
- Workspace ID: ${workspaceId}
- Connected to Bolta Cloud via secure WebSocket bridge
- ${Object.keys(AGENT_PRESETS).length} agents pre-configured and ready

## Your Team
${agentRoster}

Each agent has their own SOUL.md and HEARTBEAT.md in \`agents/<slug>/\`.
The Conductor dispatches jobs to the right agent based on your request.

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

## Bolta MCP (via mcporter)
- **URL:** ${BOLTA_MCP_URL}
- **Protocol:** HTTP/SSE (StreamableHTTP)
- **Config:** ./config/mcporter.json
- **71 tools** organized by category:

### Content Creation
- \`bolta.draft-post\` — Draft content for any platform
- \`bolta.generate-posts\` — Generate multiple posts at once
- \`bolta.enhance-post\` — Improve existing content

### Scheduling & Publishing
- \`bolta.schedule-post\` — Schedule posts for optimal times
- \`bolta.approve-post\` — Approve drafts for publishing
- \`bolta.get-inbox\` — Check pending content in inbox

### Analytics
- \`bolta.analyze-post\` — Get performance metrics
- \`bolta.get-analytics\` — Dashboard-level analytics

### Memory
- \`bolta.remember\` — Store persistent memory (brand voice, lessons)
- \`bolta.recall\` — Retrieve stored memory

### Accounts & Workspace
- \`bolta.list-accounts\` — List connected social accounts
- \`bolta.get-workspace\` — Workspace configuration

### Research
- \`bolta.web-search\` — Search the web for trends and topics

To call any tool directly: \`mcporter call bolta.<tool-name> key=value\`

## Bolta API
- **Base URL:** ${BOLTA_API_URL}
- **Auth:** Workspace API key via X-API-Key header

## Bolta Skills (local)
- **Location:** ./skills/ (ClawHub installed)
- **Source:** ${BOLTA_SKILLS_CLAWHUB_SLUG}
- 37 skill documents for agent reference

## Telegram
- If configured, agents respond to DMs via the Telegram bot
- Allowlist controls who can chat with agents
- Set bot token: \`boltaclaw config set TELEGRAM_BOT_TOKEN <token>\`
- Set allowlist: \`boltaclaw config set TELEGRAM_USER_ID <your_id>\`
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
      const bin = this.openclawBin || 'openclaw';
      this.gatewayProcess = spawn(
        bin,
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

      const bin = this.openclawBin || 'openclaw';
      const result = execSync(
        `"${bin}" --profile ${this.profileName} gateway call health --token "${token}" --json 2>/dev/null`,
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
    const bin = this.openclawBin || 'openclaw';
    const args = ['--profile', this.profileName, 'logs'];
    if (follow) args.push('-f');

    spawn(bin, args, { env: this._env(), stdio: 'inherit' });
  }

  // ─── Agent Execution ────────────────────────────────────────────

  /**
   * Execute an agent turn via the OpenClaw gateway.
   *
   * Uses `openclaw agent` which routes through the running gateway,
   * giving full access to tools, memory, skills, channels, etc.
   */
  async executeAgentTurn(message, { agentSlug = 'hype-man', systemContext = '', timeout = 180000 } = {}) {
    try {
      const token = this.config.get('gateway_token') || '';

      // Route to the specific agent — each has their own SOUL and session
      const agentId = getAgentIds().includes(agentSlug) ? agentSlug : 'hype-man';

      const args = [
        '--profile', this.profileName,
        'agent',
        '--agent', agentId,
        '--message', message,
        '--json',
        '--timeout', String(Math.floor(timeout / 1000)),
      ];

      const agentBin = this.openclawBin || 'openclaw';
      const cmd = `"${agentBin}" ` + args.map(a => {
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
