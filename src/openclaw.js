/**
 * OpenClaw Manager
 *
 * Manages the OpenClaw installation, configuration, and gateway lifecycle.
 * OpenClaw is the actual agent runtime — we configure it for Bolta use.
 *
 * What OpenClaw provides:
 * - Gateway (WebSocket server for agent sessions)
 * - Agent system (workspaces, isolated sessions, heartbeats)
 * - Channels (Telegram, Discord, Slack, etc.)
 * - Memory (LanceDB vector store)
 * - Skills (clawhub ecosystem)
 * - Cron (scheduled agent tasks)
 * - Tool execution (sandboxed shell, browser, etc.)
 *
 * What BoltaClaw adds:
 * - Bolta Cloud bridge (outbound WS to relay jobs)
 * - Bolta-skills pre-installed
 * - Bolta MCP connection
 * - Workspace token handshake
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const OPENCLAW_NPM_PACKAGE = 'openclaw';
const BOLTA_SKILLS_REPO = 'https://github.com/boltaai/bolta-skills.git';
const BOLTA_AGENT_NAME = 'bolta';

export class OpenClawManager {
  constructor(config, opts = {}) {
    this.config = config;
    this.verbose = opts.verbose || false;
    this.gatewayProcess = null;
    this.openclawBin = null;

    // OpenClaw state dir — use a bolta-specific profile
    this.stateDir = join(config.dataDir, 'openclaw');
    this.configPath = join(this.stateDir, 'openclaw.json');
    this.workspaceDir = join(this.stateDir, 'workspaces', 'bolta');
  }

  // --- Installation ---

  async check() {
    try {
      const version = execSync('openclaw --version 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      this.openclawBin = execSync('which openclaw', { encoding: 'utf-8' }).trim();
      return { installed: true, version };
    } catch {
      return { installed: false, version: null };
    }
  }

  async install() {
    console.log(chalk.gray('  Installing OpenClaw via npm...'));
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
      execSync(`npm update -g ${OPENCLAW_NPM_PACKAGE}`, {
        stdio: 'inherit',
        timeout: 120000,
      });
      console.log(chalk.green('  ✓ OpenClaw updated'));
    } catch (err) {
      console.error(chalk.red(`  ✗ Update failed: ${err.message}`));
    }

    // Update bolta-skills
    const skillsDir = this.config.get('skills_dir');
    if (skillsDir && existsSync(skillsDir)) {
      console.log(chalk.blue('  Updating bolta-skills...'));
      try {
        execSync('git pull --quiet', { cwd: skillsDir, timeout: 30000 });
        console.log(chalk.green('  ✓ bolta-skills updated'));
      } catch {
        console.error(chalk.yellow('  ⚠ Could not update bolta-skills'));
      }
    }
  }

  // --- Configuration ---

  async configure({ port = 18789, anthropicKey = null } = {}) {
    // Ensure state directories exist
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.workspaceDir, { recursive: true });

    // Clone/update bolta-skills
    const skillsDir = join(this.config.dataDir, 'skills');
    if (!existsSync(skillsDir)) {
      try {
        execSync(`git clone --depth 1 ${BOLTA_SKILLS_REPO} "${skillsDir}"`, {
          stdio: this.verbose ? 'inherit' : 'pipe',
          timeout: 60000,
        });
      } catch {
        console.log(chalk.yellow('  ⚠ Could not clone bolta-skills (agents will work without local skills)'));
      }
    }
    this.config.set('skills_dir', skillsDir);

    // Build OpenClaw config
    const ocConfig = this._buildOpenClawConfig(port, anthropicKey);
    writeFileSync(this.configPath, JSON.stringify(ocConfig, null, 2));

    // Write workspace files (AGENTS.md, SOUL.md, etc.)
    this._writeWorkspaceFiles();

    // Set environment for the OpenClaw profile
    process.env.OPENCLAW_STATE_DIR = this.stateDir;
    process.env.OPENCLAW_CONFIG_PATH = this.configPath;

    if (this.verbose) {
      console.log(chalk.gray(`  Config: ${this.configPath}`));
      console.log(chalk.gray(`  Workspace: ${this.workspaceDir}`));
      console.log(chalk.gray(`  Skills: ${skillsDir}`));
    }
  }

  _buildOpenClawConfig(port, anthropicKey) {
    const workspaceId = this.config.get('workspace_id') || 'pending';

    const config = {
      meta: {
        lastTouchedVersion: '0.1.0-boltaclaw',
        lastTouchedAt: new Date().toISOString(),
      },
      models: {
        providers: {},
      },
      agents: {
        defaults: {
          model: {
            primary: 'anthropic/claude-sonnet-4-5',
          },
          workspace: this.workspaceDir,
          heartbeat: {
            enabled: true,
            intervalMs: 1800000, // 30 min
          },
        },
        list: [],
      },
      gateway: {
        port,
        mode: 'local',
        bind: 'loopback',
        auth: {
          mode: 'token',
          token: this._generateLocalToken(),
        },
      },
      skills: {
        entries: {},
      },
      commands: {
        native: 'auto',
        nativeSkills: 'auto',
      },
    };

    // Add Anthropic provider if key is set
    if (anthropicKey) {
      // OpenClaw picks up ANTHROPIC_API_KEY from env
      process.env.ANTHROPIC_API_KEY = anthropicKey;
    }

    // Add Telegram channel if configured
    const telegramToken = this.config.get('TELEGRAM_BOT_TOKEN');
    if (telegramToken) {
      config.channels = {
        telegram: {
          botToken: telegramToken,
          dmPolicy: 'allowlist',
          groupPolicy: 'allowlist',
          streaming: true,
          allowFrom: [],
        },
      };
    }

    return config;
  }

  _writeWorkspaceFiles() {
    const workspaceId = this.config.get('workspace_id') || 'pending';

    // AGENTS.md — workspace instructions
    const agentsMd = `# Bolta Agent Workspace

## Identity
You are a Bolta AI agent running on a self-hosted OpenClaw engine.
Workspace: ${workspaceId}

## Instructions
- Execute tasks dispatched from Bolta Cloud
- Use bolta-skills tools for content creation, scheduling, and analysis
- Store memory locally using bolta_remember/bolta_recall
- Report results back to the Bolta dashboard

## Tools
- Bolta MCP: https://mcp.bolta.ai/mcp (71 tools)
- Local skills: ~/.boltaclaw/skills/

## Memory
Write important context to memory/ files for persistence across sessions.
`;

    // SOUL.md — agent persona (will be overridden by workspace config from Bolta Cloud)
    const soulMd = `# SOUL.md — Bolta Agent

You are a professional AI social media agent. You help create, schedule, and manage
social media content. You write in the brand voice configured for this workspace.

Be helpful, proactive, and creative. When drafting content, always offer alternatives
and refinements. Never publish without explicit approval unless in autopilot mode.
`;

    const writeIfMissing = (path, content) => {
      if (!existsSync(path)) writeFileSync(path, content);
    };

    writeIfMissing(join(this.workspaceDir, 'AGENTS.md'), agentsMd);
    writeIfMissing(join(this.workspaceDir, 'SOUL.md'), soulMd);
    mkdirSync(join(this.workspaceDir, 'memory'), { recursive: true });
  }

  _generateLocalToken() {
    // Generate a random token for local gateway auth
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // --- Gateway Lifecycle ---

  async startGateway() {
    const status = await this.gatewayStatus();
    if (status.running) {
      if (this.verbose) console.log(chalk.gray('  Gateway already running'));
      return;
    }

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: this.stateDir,
        OPENCLAW_CONFIG_PATH: this.configPath,
      };

      this.gatewayProcess = spawn('openclaw', ['gateway', '--force'], {
        env,
        stdio: this.verbose ? 'inherit' : 'pipe',
        detached: true,
      });

      // Give it a few seconds to start
      const timeout = setTimeout(() => {
        resolve(); // Assume it started
      }, 5000);

      this.gatewayProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Gateway failed to start: ${err.message}`));
      });

      this.gatewayProcess.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Gateway exited with code ${code}`));
        }
      });

      // Unref so it doesn't block process exit
      this.gatewayProcess.unref();
    });
  }

  async stopGateway() {
    if (this.gatewayProcess) {
      this.gatewayProcess.kill('SIGTERM');
      this.gatewayProcess = null;
    } else {
      // Try killing via openclaw command
      try {
        execSync('openclaw gateway stop 2>/dev/null', {
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: this.stateDir,
            OPENCLAW_CONFIG_PATH: this.configPath,
          },
          timeout: 5000,
        });
      } catch {
        // Already stopped
      }
    }
  }

  async gatewayStatus() {
    try {
      const result = execSync('openclaw health 2>/dev/null', {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: this.stateDir,
          OPENCLAW_CONFIG_PATH: this.configPath,
        },
        timeout: 5000,
      });
      return { running: true, output: result.trim() };
    } catch {
      return { running: false };
    }
  }

  async tailLogs(follow = false) {
    const args = ['logs'];
    if (follow) args.push('-f');

    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configPath,
    };

    const proc = spawn('openclaw', args, { env, stdio: 'inherit' });
    proc.on('error', () => {
      console.error(chalk.red('  Could not tail logs. Is OpenClaw installed?'));
    });
  }

  // --- Agent Management ---

  /**
   * Send a message to the OpenClaw agent and get a response.
   * Used by the Bridge to execute Bolta Cloud jobs locally.
   */
  async executeAgentTurn(message, { systemContext = '', timeout = 120000 } = {}) {
    try {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: this.stateDir,
        OPENCLAW_CONFIG_PATH: this.configPath,
      };

      // Use `openclaw agent` command to run a single agent turn
      const args = ['agent', '--message', message];
      if (systemContext) {
        args.push('--system', systemContext);
      }

      const result = execSync(`openclaw ${args.map(a => `"${a}"`).join(' ')}`, {
        encoding: 'utf-8',
        env,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      return { success: true, output: result.trim() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Get the gateway WebSocket URL for direct API access.
   */
  getGatewayUrl() {
    const config = this._readConfig();
    const port = config?.gateway?.port || 18789;
    return `ws://127.0.0.1:${port}`;
  }

  _readConfig() {
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}
