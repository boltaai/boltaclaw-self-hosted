#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import process from 'process';
import { setup, onboard } from './setup.js';
import { Bridge } from './bridge.js';
import { Config } from './config.js';
import { OpenClawManager } from './openclaw.js';
import { TelegramWebhook } from './telegram.js';
import { BoltaAPIClient } from './api-client.js';

const program = new Command();
const DEFAULT_PRIMARY_MODEL = 'anthropic/claude-sonnet-4-6';

function isValidWorkspaceToken(token) {
  return typeof token === 'string' && (token.startsWith('workspace_live_') || token.startsWith('rk_'));
}

program
  .name('boltaclaw')
  .description('Bolta OpenClaw Engine — run your AI agents locally')
  .version('0.1.0');

program
  .command('start')
  .description('Start the Bolta OpenClaw engine and connect to Bolta Cloud')
  .option('--token <token>', 'Workspace token for initial handshake')
  .option('--verbose', 'Enable verbose logging')
  .option('--no-gateway', 'Skip starting OpenClaw gateway (bridge-only mode)')
  .option('--port <port>', 'OpenClaw gateway port', '18789')
  .option('--telegram-port <port>', 'Telegram webhook listener port', '8080')
  .option('--telegram-url <url>', 'Public URL for Telegram webhook registration')
  .action(async (opts) => {
    console.log(chalk.blue.bold('\n  ⚡ Bolta OpenClaw Engine v0.1.0\n'));

    const config = new Config();

    // If token provided, store it for handshake
    if (opts.token) {
      if (!isValidWorkspaceToken(opts.token)) {
        console.log(chalk.red('  ✗ Invalid token format.'));
        console.log(chalk.gray('    Expected workspace_live_... or rk_...\n'));
        process.exit(1);
      }
      if (opts.token.startsWith('rk_')) {
        config.set('runner_key', opts.token);
        console.log(chalk.green('  ✓ Runner key saved'));
      } else {
        config.set('install_token', opts.token);
        console.log(chalk.green('  ✓ Workspace token saved'));
      }
    }

    // Check for existing runner key or install token
    const runnerKey = config.get('runner_key');
    const installToken = config.get('install_token');

    if (!runnerKey && !installToken) {
      console.log(chalk.red('  ✗ No workspace token found.'));
      console.log(chalk.gray('    Run: boltaclaw start --token=YOUR_TOKEN'));
      console.log(chalk.gray('    Get your token from Settings → Self-Hosted in the Bolta dashboard.\n'));
      process.exit(1);
    }
    if (runnerKey && !isValidWorkspaceToken(runnerKey)) {
      console.log(chalk.red('  ✗ Stored runner_key has invalid format.'));
      console.log(chalk.gray('    Reset with: boltaclaw start --token=rk_...\n'));
      process.exit(1);
    }
    if (installToken && !isValidWorkspaceToken(installToken)) {
      console.log(chalk.red('  ✗ Stored install_token has invalid format.'));
      console.log(chalk.gray('    Reset with: boltaclaw start --token=workspace_live_...\n'));
      process.exit(1);
    }

    // Step 1: Ensure OpenClaw is installed and configured
    const ocManager = new OpenClawManager(config, { verbose: opts.verbose });
    if (!config.get('MODEL_PRIMARY')) {
      config.set('MODEL_PRIMARY', DEFAULT_PRIMARY_MODEL);
    }

    const spinner = ora('Checking OpenClaw installation...').start();
    const ocStatus = await ocManager.check();

    if (!ocStatus.installed) {
      spinner.text = 'Installing OpenClaw...';
      await ocManager.install();
      spinner.succeed('OpenClaw installed');
    } else {
      spinner.succeed(`OpenClaw ${ocStatus.version} found`);
    }

    // Step 2: Configure OpenClaw for Bolta
    const configSpinner = ora('Configuring OpenClaw for Bolta...').start();
    await ocManager.configure({
      port: parseInt(opts.port, 10),
      anthropicKey: config.get('ANTHROPIC_API_KEY'),
      modelPrimary: config.get('MODEL_PRIMARY') || DEFAULT_PRIMARY_MODEL,
    });
    configSpinner.succeed('OpenClaw configured');

    // Step 3: Start OpenClaw gateway (unless --no-gateway)
    if (opts.gateway !== false) {
      const gwSpinner = ora('Starting OpenClaw gateway...').start();
      await ocManager.startGateway();
      // Re-apply channel config after gateway starts (gateway overwrites openclaw.json on startup)
      ocManager.configureChannels();
      gwSpinner.succeed('OpenClaw gateway running');
    }

    // Step 4: Start the Bolta Cloud bridge (WebSocket)
    const bridgeSpinner = ora('Connecting to Bolta Cloud...').start();
    const bridge = new Bridge(config, ocManager, { verbose: opts.verbose });

    try {
      await bridge.connect();
      bridgeSpinner.succeed('Connected to Bolta Cloud');
    } catch (err) {
      bridgeSpinner.fail('Connection failed');
      console.error(chalk.red(`  ${err.message}\n`));
      process.exit(1);
    }

    console.log(chalk.green.bold('\n  🟢 Engine is online'));
    console.log(chalk.gray('  Waiting for jobs from Bolta dashboard...\n'));
    console.log(chalk.gray(`  OpenClaw gateway: ws://127.0.0.1:${opts.port}`));

    // Step 5: Start Telegram webhook if configured
    let telegramWebhook = null;
    if (config.get('TELEGRAM_BOT_TOKEN')) {
      try {
        telegramWebhook = new TelegramWebhook(config, {
          port: parseInt(opts.telegramPort, 10),
          publicUrl: opts.telegramUrl || config.get('TELEGRAM_WEBHOOK_URL') || '',
          verbose: opts.verbose,
          onMessage: async ({ chatId, userId, text, username }) => {
            // Dispatch as a job via bridge
            console.log(`  📨 Telegram job from @${username}: "${text.slice(0, 60)}..."`);
            bridge.ws.send('telegram_message', {
              chat_id: chatId,
              user_id: userId,
              text,
              username,
            });
            return '⏳ Got it — your agents are on it.';
          },
        });
        await telegramWebhook.start();
        console.log(chalk.gray(`  Telegram webhook: http://0.0.0.0:${opts.telegramPort}`));
      } catch (err) {
        console.error(chalk.yellow(`  ⚠ Telegram webhook failed to start: ${err.message}`));
        console.error(chalk.gray('    Agents will still work — Telegram just won\'t be available.'));
      }
    }

    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Graceful shutdown
    const shutdown = async () => {
      console.log(chalk.yellow('\n  Shutting down...'));
      if (telegramWebhook) await telegramWebhook.stop();
      await bridge.disconnect();
      await ocManager.stopGateway();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('setup')
  .description('Interactive setup wizard')
  .option('--token <token>', 'Workspace token')
  .action(async (opts) => {
    await setup(opts);
  });

program
  .command('onboard')
  .description('Guided onboarding (token, API key, model, OpenClaw profile)')
  .option('--token <token>', 'Workspace token (workspace_live_... or rk_...)')
  .option('--model <model>', 'Default model', 'anthropic/claude-sonnet-4-6')
  .option('--verbose', 'Enable verbose logging')
  .option('--no-openclaw-onboard', 'Skip running `openclaw --profile bolta onboard`')
  .option('--port <port>', 'OpenClaw gateway port', '18789')
  .action(async (opts) => {
    try {
      await onboard(opts);
    } catch (err) {
      console.error(chalk.red(`\n  ✗ Onboarding failed: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check engine status')
  .action(async () => {
    const config = new Config();
    const ocManager = new OpenClawManager(config);

    console.log(chalk.blue.bold('\n  Bolta OpenClaw Engine Status\n'));

    // OpenClaw status
    const ocStatus = await ocManager.check();
    console.log(`  OpenClaw:     ${ocStatus.installed ? chalk.green(`v${ocStatus.version}`) : chalk.red('not installed')}`);

    // Gateway status
    const gwStatus = await ocManager.gatewayStatus();
    console.log(`  Gateway:      ${gwStatus.running ? chalk.green('running') : chalk.gray('stopped')}`);

    // Connection status
    const runnerKey = config.get('runner_key');
    const workspaceId = config.get('workspace_id');
    console.log(`  Workspace:    ${workspaceId || chalk.gray('not configured')}`);
    console.log(`  Runner Key:   ${runnerKey ? chalk.green('configured') : chalk.red('not set')}`);
    console.log(`  API Key:      ${config.get('ANTHROPIC_API_KEY') ? chalk.green('configured') : chalk.yellow('not set')}`);

    // Skills
    const skillsDir = config.get('skills_dir');
    console.log(`  Skills:       ${skillsDir || chalk.gray('not installed')}`);

    console.log(`  Data Dir:     ${config.dataDir}`);
    console.log();
  });

program
  .command('config')
  .description('Manage local configuration')
  .argument('<action>', '"set" or "get"')
  .argument('<key>', 'Configuration key')
  .argument('[value]', 'Value to set')
  .action((action, key, value) => {
    const config = new Config();
    if (action === 'set' && value) {
      config.set(key, value);
      // Special handling for sensitive keys
      if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token')) {
        console.log(chalk.green(`  ✓ ${key} saved locally (never sent to Bolta Cloud)`));
      } else {
        console.log(chalk.green(`  ✓ ${key} = ${value}`));
      }
    } else if (action === 'get') {
      const val = config.get(key);
      console.log(val || chalk.gray('(not set)'));
    } else {
      console.log(chalk.red('  Usage: boltaclaw config set KEY VALUE'));
    }
  });

program
  .command('logs')
  .description('Tail OpenClaw gateway logs')
  .option('-f, --follow', 'Follow log output')
  .action(async (opts) => {
    const ocManager = new OpenClawManager(new Config());
    await ocManager.tailLogs(opts.follow);
  });

program
  .command('gateway')
  .alias('gw')
  .description('Manage the local OpenClaw gateway')
  .argument('<action>', '"start", "stop", or "health"')
  .action(async (action) => {
    const config = new Config();
    const ocManager = new OpenClawManager(config);
    const normalized = String(action || '').toLowerCase();

    if (normalized === 'start') {
      const spinner = ora('Starting OpenClaw gateway...').start();
      try {
        const status = await ocManager.check();
        if (!status.installed) {
          spinner.text = 'Installing OpenClaw...';
          await ocManager.install();
        }
        await ocManager.startGateway();
        spinner.succeed('Gateway running');
      } catch (err) {
        spinner.fail(`Failed to start gateway: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    if (normalized === 'stop') {
      const spinner = ora('Stopping OpenClaw gateway...').start();
      try {
        await ocManager.stopGateway();
        spinner.succeed('Gateway stopped');
      } catch (err) {
        spinner.fail(`Failed to stop gateway: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    if (normalized === 'health' || normalized === 'status') {
      const status = await ocManager.gatewayStatus();
      if (status.running) {
        console.log(chalk.green('healthy'));
      } else {
        console.log(chalk.red('stopped'));
        process.exitCode = 1;
      }
      return;
    }

    console.error(chalk.red('Unknown gateway action.'));
    console.error(chalk.gray('Usage: boltaclaw gateway <start|stop|health>'));
    process.exit(1);
  });

program
  .command('openclaw')
  .alias('oc')
  .description('Run a raw OpenClaw command using the bolta profile')
  .argument('[args...]', 'Arguments passed to OpenClaw')
  .allowUnknownOption(true)
  .action(async (args = []) => {
    const ocManager = new OpenClawManager(new Config());
    try {
      const code = await ocManager.runOpenClaw(args, { stdio: 'inherit' });
      process.exitCode = code;
    } catch (err) {
      console.error(chalk.red(`  ✗ ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Run runtime diagnostics and report actionable issues')
  .action(async () => {
    const config = new Config();
    const ocManager = new OpenClawManager(config);
    const findings = [];

    const add = (ok, label, detail = '') => {
      findings.push({ ok, label, detail });
    };

    // Node runtime check
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (Number.isFinite(major) && major >= 18) {
      add(true, `Node.js ${process.versions.node}`, 'meets >=18 requirement');
    } else {
      add(false, `Node.js ${process.versions.node}`, 'requires Node.js 18+');
    }

    // Token and key checks
    const runnerKey = config.get('runner_key');
    const installToken = config.get('install_token');
    add(Boolean(runnerKey || installToken), 'Workspace auth token', runnerKey ? 'runner key configured' : installToken ? 'install token configured' : 'not configured');
    const hasLlmKey = Boolean(config.get('ANTHROPIC_API_KEY') || config.get('OPENAI_API_KEY'));
    add(hasLlmKey, 'LLM API key', hasLlmKey ? 'configured' : 'needs ANTHROPIC_API_KEY or OPENAI_API_KEY');

    // OpenClaw install check
    const ocStatus = await ocManager.check();
    add(
      ocStatus.installed,
      'OpenClaw installation',
      ocStatus.installed ? `v${ocStatus.version} (${ocStatus.bin})` : 'not installed'
    );

    // Gateway check
    const gwStatus = await ocManager.gatewayStatus();
    const gwPort = config.get('gateway_port') || '18789';
    add(gwStatus.running, 'Gateway listener', `${gwStatus.running ? 'running' : 'stopped'} on 127.0.0.1:${gwPort}`);

    // Profile-level OpenClaw check (if installed)
    if (ocStatus.installed) {
      try {
        const code = await ocManager.runOpenClaw(['gateway', 'health'], { stdio: 'ignore' });
        add(code === 0, 'OpenClaw gateway health command', code === 0 ? 'command succeeds' : `exit code ${code}`);
      } catch (err) {
        add(false, 'OpenClaw gateway health command', err.message);
      }
    } else {
      add(false, 'OpenClaw gateway health command', 'skipped (OpenClaw not installed)');
    }

    console.log(chalk.blue.bold('\n  Boltaclaw Doctor\n'));
    for (const f of findings) {
      const icon = f.ok ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${f.label}${f.detail ? chalk.gray(` — ${f.detail}`) : ''}`);
    }
    console.log();

    if (findings.some((f) => !f.ok)) {
      process.exitCode = 1;
    }
  });

program
  .command('action')
  .description('Proxy to `openclaw action ...` using the bolta profile')
  .argument('[args...]', 'Arguments passed to OpenClaw action')
  .allowUnknownOption(true)
  .action(async (args = []) => {
    const ocManager = new OpenClawManager(new Config());
    try {
      const code = await ocManager.runOpenClaw(['action', ...args], { stdio: 'inherit' });
      process.exitCode = code;
    } catch (err) {
      console.error(chalk.red(`  ✗ ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('uninstall')
  .description('Stop gateway and remove local Boltaclaw/OpenClaw state')
  .option('--purge', 'Also delete Boltaclaw local data (~/.boltaclaw)')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (opts) => {
    if (!opts.yes) {
      console.error(chalk.yellow('This removes local runtime files.'));
      console.error(chalk.gray('Re-run with: boltaclaw uninstall --yes [--purge]'));
      process.exit(1);
    }

    const spinner = ora('Uninstalling local runtime...').start();
    try {
      const ocManager = new OpenClawManager(new Config());
      await ocManager.uninstall({ removeData: Boolean(opts.purge) });
      spinner.succeed(opts.purge
        ? 'Uninstalled OpenClaw profile and Boltaclaw local data'
        : 'Uninstalled OpenClaw profile');
    } catch (err) {
      spinner.fail(`Uninstall failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update OpenClaw and bolta-skills to latest')
  .action(async () => {
    const config = new Config();
    const ocManager = new OpenClawManager(config);
    await ocManager.update();
  });

// ─── API-based CLI commands ──────────────────────────────────────────────────

program
  .command('run')
  .description('Run an agent with a prompt (API-based, server-side execution)')
  .argument('<prompt...>', 'The prompt to send to the agent')
  .option('--agent <agent>', 'Agent slug (e.g. hype-man, hunter, deep-diver, loop-operator)')
  .option('--local', 'Run locally via OpenClaw instead of API (BYOK)')
  .option('--json', 'Output raw JSON events instead of formatted text')
  .action(async (promptParts, opts) => {
    const prompt = promptParts.join(' ');
    const config = new Config();

    // Local mode: use OpenClaw directly
    if (opts.local) {
      const ocManager = new OpenClawManager(config);
      const spinner = ora('Running locally...').start();
      const result = await ocManager.executeAgentTurn(prompt, {
        agentSlug: opts.agent || 'hype-man',
      });
      spinner.stop();
      if (result.success) {
        console.log(result.output);
      } else {
        console.error(chalk.red(`Error: ${result.error}`));
        process.exit(1);
      }
      return;
    }

    // API mode: stream from server
    const client = new BoltaAPIClient(config);
    const validation = client.validate();
    if (!validation.ok) {
      console.error(chalk.red(`  ✗ ${validation.error}`));
      process.exit(1);
    }

    const spinner = ora({ text: 'Thinking...', color: 'cyan' }).start();
    let spinnerStopped = false;

    try {
      await client.streamRun(prompt, { agent: opts.agent }, (event) => {
        if (opts.json) {
          console.log(JSON.stringify(event));
          return;
        }

        switch (event.event) {
          case 'event': {
            const d = event.data;
            if (d.type === 'routing') {
              const agents = d.agents?.join(', ') || '';
              spinner.text = agents ? `Routing to ${agents}...` : d.message;
            } else if (d.type === 'delegation') {
              spinner.text = d.message;
            } else if (d.type === 'thought') {
              spinner.text = `${d.agent_display || ''}: ${d.message}`;
            }
            break;
          }
          case 'response': {
            if (!spinnerStopped) {
              spinner.stop();
              spinnerStopped = true;
            }
            console.log();
            console.log(event.data.message);
            console.log();
            if (event.data.agents_involved?.length) {
              console.log(chalk.gray(`  Agents: ${event.data.agents_involved.join(', ')}`));
            }
            break;
          }
          case 'error': {
            if (!spinnerStopped) {
              spinner.fail(event.data.error || 'Unknown error');
              spinnerStopped = true;
            }
            break;
          }
          case 'done': {
            if (!spinnerStopped) {
              spinner.stop();
              spinnerStopped = true;
            }
            break;
          }
        }
      });
    } catch (err) {
      spinner.fail(`Error: ${err.message}`);
      process.exit(1);
    }
  });


program
  .command('chat')
  .description('Interactive chat with your agents (API-based)')
  .option('--agent <agent>', 'Default agent slug')
  .option('--local', 'Run locally via OpenClaw instead of API (BYOK)')
  .action(async (opts) => {
    const config = new Config();

    if (opts.local) {
      console.log(chalk.blue.bold('\n  ⚡ BoltaClaw Chat (local mode)\n'));
      console.log(chalk.gray('  Using local OpenClaw runtime. Type /quit to exit.\n'));

      const ocManager = new OpenClawManager(config);
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const askQuestion = () => {
        rl.question(chalk.cyan('  you → '), async (input) => {
          const trimmed = input.trim();
          if (!trimmed || trimmed === '/quit' || trimmed === '/exit') {
            console.log(chalk.gray('\n  Goodbye.\n'));
            rl.close();
            return;
          }

          const spinner = ora({ text: 'Thinking...', color: 'cyan' }).start();
          const result = await ocManager.executeAgentTurn(trimmed, {
            agentSlug: opts.agent || 'hype-man',
          });
          spinner.stop();

          if (result.success) {
            console.log(chalk.white(`\n  ${result.output}\n`));
          } else {
            console.log(chalk.red(`\n  Error: ${result.error}\n`));
          }

          askQuestion();
        });
      };

      askQuestion();
      return;
    }

    // API mode
    const client = new BoltaAPIClient(config);
    const validation = client.validate();
    if (!validation.ok) {
      console.error(chalk.red(`  ✗ ${validation.error}`));
      process.exit(1);
    }

    console.log(chalk.blue.bold('\n  ⚡ BoltaClaw Chat\n'));
    console.log(chalk.gray('  Connected to Bolta API. Type /quit to exit, /status for workspace info.\n'));

    const history = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const askQuestion = () => {
      rl.question(chalk.cyan('  you → '), async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          askQuestion();
          return;
        }

        // REPL commands
        if (trimmed === '/quit' || trimmed === '/exit') {
          console.log(chalk.gray('\n  Goodbye.\n'));
          rl.close();
          return;
        }

        if (trimmed === '/status') {
          try {
            const status = await client.getStatus();
            console.log();
            console.log(chalk.bold('  Agents:'));
            for (const a of status.agents || []) {
              const icon = a.status === 'active' ? chalk.green('●') : chalk.gray('○');
              console.log(`    ${icon} ${a.name} (${a.type})`);
            }
            console.log(chalk.bold('\n  Accounts:'));
            for (const a of status.accounts || []) {
              console.log(`    ${a.platform}: @${a.username}`);
            }
            console.log();
          } catch (err) {
            console.log(chalk.red(`\n  Error: ${err.message}\n`));
          }
          askQuestion();
          return;
        }

        if (trimmed === '/clear') {
          history.length = 0;
          console.log(chalk.gray('\n  History cleared.\n'));
          askQuestion();
          return;
        }

        if (trimmed === '/help') {
          console.log();
          console.log(chalk.bold('  Commands:'));
          console.log('    /status   — Show workspace agents and accounts');
          console.log('    /clear    — Clear conversation history');
          console.log('    /quit     — Exit chat');
          console.log('    /help     — Show this help');
          console.log();
          askQuestion();
          return;
        }

        // Send message via API
        const spinner = ora({ text: 'Thinking...', color: 'cyan' }).start();
        let responseText = '';

        try {
          await client.streamRun(trimmed, { history }, (event) => {
            if (event.event === 'event') {
              const d = event.data;
              if (d.type === 'routing' && d.agents?.length) {
                spinner.text = `Routing to ${d.agents.join(', ')}...`;
              } else if (d.message) {
                spinner.text = d.message;
              }
            } else if (event.event === 'response') {
              spinner.stop();
              responseText = event.data.message;
              console.log(chalk.white(`\n  ${responseText}\n`));
            } else if (event.event === 'error') {
              spinner.fail(event.data.error || 'Unknown error');
            } else if (event.event === 'done') {
              spinner.stop();
            }
          });
        } catch (err) {
          spinner.fail(`Error: ${err.message}`);
        }

        // Maintain conversation history
        history.push({ role: 'user', content: trimmed });
        if (responseText) {
          history.push({ role: 'assistant', content: responseText });
        }
        // Keep history bounded
        if (history.length > 20) {
          history.splice(0, history.length - 20);
        }

        askQuestion();
      });
    };

    askQuestion();
  });


program
  .command('whoami')
  .description('Show workspace status and connected agents')
  .action(async () => {
    const config = new Config();
    const client = new BoltaAPIClient(config);
    const validation = client.validate();
    if (!validation.ok) {
      console.error(chalk.red(`  ✗ ${validation.error}`));
      process.exit(1);
    }

    const spinner = ora('Fetching workspace info...').start();
    try {
      const status = await client.getStatus();
      spinner.stop();

      console.log(chalk.blue.bold('\n  Workspace Status\n'));
      console.log(`  Workspace:  ${status.workspace_id}`);

      console.log(chalk.bold('\n  Agents:'));
      if (status.agents?.length) {
        for (const a of status.agents) {
          const icon = a.status === 'active' ? chalk.green('●') : chalk.gray('○');
          console.log(`    ${icon} ${a.name} (${a.slug || a.type}) — ${a.status}`);
        }
      } else {
        console.log(chalk.gray('    No agents configured'));
      }

      console.log(chalk.bold('\n  Connected Accounts:'));
      if (status.accounts?.length) {
        for (const a of status.accounts) {
          console.log(`    ${a.platform}: @${a.username}`);
        }
      } else {
        console.log(chalk.gray('    No accounts connected'));
      }

      console.log(chalk.bold('\n  Recent Runs:'));
      if (status.recent_runs?.length) {
        for (const r of status.recent_runs.slice(0, 5)) {
          const icon = r.status === 'completed' ? chalk.green('✓')
            : r.status === 'failed' ? chalk.red('✗')
            : chalk.yellow('…');
          const time = r.started_at ? new Date(r.started_at).toLocaleString() : 'unknown';
          console.log(`    ${icon} ${r.agent} (${r.trigger}) — ${time}`);
        }
      } else {
        console.log(chalk.gray('    No recent runs'));
      }

      console.log();
    } catch (err) {
      spinner.fail(`Error: ${err.message}`);
      process.exit(1);
    }
  });


program.parse();
