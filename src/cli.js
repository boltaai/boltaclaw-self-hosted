#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { Runner } from './runner.js';
import { Config } from './config.js';

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

    const spinner = ora('Connecting to Bolta Cloud...').start();

    try {
      const runner = new Runner(config, { verbose: opts.verbose });
      await runner.connect();
      spinner.succeed('Connected to Bolta Cloud');

      console.log(chalk.green.bold('\n  🟢 Engine is online'));
      console.log(chalk.gray('  Waiting for jobs from Bolta dashboard...\n'));
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));

      // Keep process alive
      process.on('SIGINT', async () => {
        console.log(chalk.yellow('\n  Shutting down...'));
        await runner.disconnect();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        await runner.disconnect();
        process.exit(0);
      });
    } catch (err) {
      spinner.fail('Connection failed');
      console.error(chalk.red(`  ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check engine status')
  .action(() => {
    const config = new Config();
    const runnerKey = config.get('runner_key');
    const workspaceId = config.get('workspace_id');

    console.log(chalk.blue.bold('\n  Bolta OpenClaw Engine Status\n'));
    console.log(`  Workspace:  ${workspaceId || chalk.gray('not configured')}`);
    console.log(`  Runner Key: ${runnerKey ? chalk.green('configured') : chalk.red('not set')}`);
    console.log(`  Data Dir:   ${config.dataDir}`);
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
      console.log(chalk.green(`  ✓ ${key} saved locally`));
    } else if (action === 'get') {
      const val = config.get(key);
      console.log(val || chalk.gray('(not set)'));
    } else {
      console.log(chalk.red('  Usage: boltaclaw config set KEY VALUE'));
    }
  });

program.parse();
