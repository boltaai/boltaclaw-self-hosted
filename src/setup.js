/**
 * Interactive setup wizard for BoltaClaw.
 *
 * Guides the user through:
 * 1. Workspace token (from Bolta dashboard)
 * 2. Claude API key (BYOK, stored locally)
 * 3. Optional: Telegram bot token
 * 4. Test connection to Bolta Cloud
 */

import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { Config } from './config.js';
import { OpenClawManager } from './openclaw.js';

function ask(rl, question, opts = {}) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

export async function setup(opts = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = new Config();

  console.log(chalk.blue.bold('\n  ⚡ Bolta OpenClaw Engine — Setup Wizard\n'));
  console.log(chalk.gray('  This wizard will configure your local engine.\n'));

  // Step 1: Workspace Token
  console.log(chalk.white.bold('  Step 1: Workspace Token'));
  console.log(chalk.gray('  Get this from Settings → Self-Hosted in the Bolta dashboard.\n'));

  let token = opts.token || '';
  if (!token) {
    token = await ask(rl, chalk.cyan('  Workspace token: '));
  }

  if (!token.startsWith('workspace_live_') && !token.startsWith('rk_')) {
    console.log(chalk.yellow('  ⚠ Token format looks unusual. Expected workspace_live_... or rk_...'));
    const proceed = await ask(rl, chalk.cyan('  Continue anyway? (y/n): '));
    if (proceed.toLowerCase() !== 'y') {
      console.log(chalk.gray('\n  Setup cancelled.\n'));
      rl.close();
      return;
    }
  }

  if (token.startsWith('rk_')) {
    config.set('runner_key', token);
  } else {
    config.set('install_token', token);
  }
  console.log(chalk.green('  ✓ Token saved\n'));

  // Step 2: Claude API Key
  console.log(chalk.white.bold('  Step 2: Claude API Key (BYOK)'));
  console.log(chalk.gray('  Powers your agents locally. Get one from console.anthropic.com'));
  console.log(chalk.gray('  This key is stored locally and NEVER sent to Bolta Cloud.\n'));

  const apiKey = await ask(rl, chalk.cyan('  Anthropic API key (sk-ant-...): '));
  if (apiKey) {
    if (!apiKey.startsWith('sk-ant-')) {
      console.log(chalk.yellow('  ⚠ Key should start with sk-ant-. Check your key.'));
    }
    config.set('ANTHROPIC_API_KEY', apiKey);
    console.log(chalk.green('  ✓ API key saved locally\n'));
  } else {
    console.log(chalk.yellow('  ⚠ Skipped — agents won\'t work without an API key.'));
    console.log(chalk.gray('    Run: boltaclaw config set ANTHROPIC_API_KEY sk-ant-...\n'));
  }

  // Step 3: Telegram (optional)
  console.log(chalk.white.bold('  Step 3: Telegram Bot (optional)'));
  console.log(chalk.gray('  Connect a Telegram bot to chat with your agents from your phone.'));
  console.log(chalk.gray('  Create a bot via @BotFather on Telegram.\n'));

  const telegramToken = await ask(rl, chalk.cyan('  Telegram bot token (or press Enter to skip): '));
  if (telegramToken) {
    config.set('TELEGRAM_BOT_TOKEN', telegramToken);
    console.log(chalk.green('  ✓ Telegram bot token saved'));

    const tgUserId = await ask(rl, chalk.cyan('  Your Telegram user ID (for allowlist, or press Enter to allow all): '));
    if (tgUserId) {
      config.set('TELEGRAM_USER_ID', tgUserId);
      console.log(chalk.green(`  ✓ Allowlisted Telegram ID: ${tgUserId}\n`));
    } else {
      console.log(chalk.gray('  DMs open to all (you can restrict later via config).\n'));
    }
  } else {
    console.log(chalk.gray('  Skipped — you can add Telegram later.\n'));
  }

  // Step 4: Check OpenClaw installation
  console.log(chalk.white.bold('  Step 4: Checking OpenClaw...\n'));
  const ocManager = new OpenClawManager(config, { verbose: false });
  const status = await ocManager.check();

  if (status.installed) {
    console.log(chalk.green(`  ✓ OpenClaw ${status.version} found\n`));
  } else {
    const installOc = await ask(rl, chalk.cyan('  OpenClaw not found. Install it now? (y/n): '));
    if (installOc.toLowerCase() === 'y') {
      const spinner = ora('  Installing OpenClaw...').start();
      try {
        await ocManager.install();
        spinner.succeed('  OpenClaw installed');
      } catch (err) {
        spinner.fail(`  Installation failed: ${err.message}`);
      }
    }
    console.log();
  }

  // Done
  console.log(chalk.green.bold('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.green.bold('  ✅ Setup complete!'));
  console.log(chalk.green.bold('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  console.log(chalk.white('  Start your engine:'));
  console.log(chalk.cyan('  $ boltaclaw start\n'));
  console.log(chalk.gray('  Your data stays local. Your keys stay local.'));
  console.log(chalk.gray('  Happy posting! 🚀\n'));

  rl.close();
}
