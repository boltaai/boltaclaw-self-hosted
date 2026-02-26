#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { setup } from './setup.js';
import { Bridge } from './bridge.js';
import { Config } from './config.js';
import { OpenClawManager } from './openclaw.js';

const program = new Command();

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
  .action(async (opts) => {
    console.log(chalk.blue.bold('\n  ⚡ Bolta OpenClaw Engine v0.1.0\n'));

    const config = new Config();

    // If token provided, store it for handshake
    if (opts.token) {
      config.set('install_token', opts.token);
      console.log(chalk.green('  ✓ Workspace token saved'));
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

    // Step 1: Ensure OpenClaw is installed and configured
    const ocManager = new OpenClawManager(config, { verbose: opts.verbose });

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
    });
    configSpinner.succeed('OpenClaw configured');

    // Step 3: Start OpenClaw gateway (unless --no-gateway)
    if (opts.gateway !== false) {
      const gwSpinner = ora('Starting OpenClaw gateway...').start();
      await ocManager.startGateway();
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
    console.log(chalk.gray('  Press Ctrl+C to stop\n'));

    // Graceful shutdown
    const shutdown = async () => {
      console.log(chalk.yellow('\n  Shutting down...'));
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
  .command('update')
  .description('Update OpenClaw and bolta-skills to latest')
  .action(async () => {
    const config = new Config();
    const ocManager = new OpenClawManager(config);
    await ocManager.update();
  });

program.parse();
