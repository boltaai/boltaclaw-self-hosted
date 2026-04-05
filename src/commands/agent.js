/**
 * `boltaclaw agent` — Agent management commands.
 *
 * Subcommands: list, hire, enable, disable
 */

import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { Config } from '../config.js';
import { BoltaAPIClient } from '../api-client.js';
import { printSection, printTable, statusBadge } from '../tui.js';

// ─── Interactive prompt helpers ─────────────────────────────────────────────

function createPrompt() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptChoice(rl, label, options) {
  console.log();
  console.log(chalk.bold(`  ${label}`));
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    console.log(`    ${chalk.cyan(i + 1)}. ${opt.label}${opt.detail ? chalk.gray(` — ${opt.detail}`) : ''}`);
  }
  console.log();

  while (true) {
    const input = await ask(rl, chalk.cyan('  Choose (number): '));
    const idx = parseInt(input.trim(), 10) - 1;
    if (idx >= 0 && idx < options.length) {
      return options[idx];
    }
    console.log(chalk.yellow('  Invalid choice. Try again.'));
  }
}

// ─── Resolve agent by ID or name ────────────────────────────────────────────

function findAgent(agents, query) {
  const lower = query.toLowerCase();
  return agents.find(
    (a) =>
      a.id === query ||
      (a.name && a.name.toLowerCase() === lower) ||
      (a.slug && a.slug.toLowerCase() === lower)
  );
}

// ─── Command registration ───────────────────────────────────────────────────

export function registerAgentCommands(program) {
  const agent = program
    .command('agent')
    .description('Manage agents (list, hire, enable, disable)');

  // ── agent list ──────────────────────────────────────────────────────────

  agent
    .command('list')
    .description('List hired agents in this workspace')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const client = buildClient();

      const spinner = ora('Fetching agents...').start();
      try {
        const data = await client.getAgentsV2();
        spinner.stop();

        const agents = data.results || data.agents || data || [];

        if (opts.json) {
          console.log(JSON.stringify(agents, null, 2));
          return;
        }

        printSection('Your Agents');

        if (!Array.isArray(agents) || agents.length === 0) {
          console.log(chalk.gray('  No agents hired yet.'));
          console.log(chalk.gray('  Hire one: boltaclaw agent hire'));
          console.log();
          return;
        }

        printTable(
          ['Name', 'Type', 'Status', 'Slug', 'ID'],
          agents.map((a) => [
            a.name,
            a.type || '',
            statusBadge(a.status),
            chalk.gray(a.slug || ''),
            chalk.gray(a.id?.slice(0, 8) || ''),
          ])
        );
        console.log();
      } catch (err) {
        spinner.fail(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── agent hire ──────────────────────────────────────────────────────────

  agent
    .command('hire')
    .argument('[preset]', 'Preset ID to hire (e.g. hype_man, hunter)')
    .description('Hire an agent preset (creates agent + default job)')
    .option('--name <name>', 'Custom agent name')
    .option('--voice-profile <id>', 'Voice profile ID')
    .option('--accounts <ids>', 'Comma-separated account IDs')
    .option('--json', 'Output raw JSON')
    .action(async (presetArg, opts) => {
      const client = buildClient();
      let presetId = presetArg;

      // Interactive: pick a preset if not provided
      if (!presetId) {
        const spinner = ora('Fetching presets...').start();
        let presets;
        try {
          const data = await client.getPresets();
          presets = (data.presets || []).filter((p) => !p.comingSoon);
          spinner.stop();
        } catch (err) {
          spinner.fail(`Error: ${err.message}`);
          process.exit(1);
        }

        if (presets.length === 0) {
          console.log(chalk.red('  No presets available.'));
          process.exit(1);
        }

        const rl = createPrompt();
        try {
          const chosen = await promptChoice(rl, 'Choose an agent preset:', presets.map((p) => ({
            label: `${p.emoji || ''} ${p.name}`.trim(),
            detail: p.tagline,
            value: p.id || p.slug,
          })));
          presetId = chosen.value;

          // Interactive: voice profile for content creators
          if (!opts.voiceProfile) {
            const preset = presets.find((p) => (p.id || p.slug) === presetId);
            if (preset && preset.type === 'content_creator') {
              try {
                const vpData = await client.getVoiceProfiles();
                const profiles = vpData.profiles || vpData.results || vpData || [];
                if (Array.isArray(profiles) && profiles.length > 0) {
                  const vpChoice = await promptChoice(rl, 'Choose a voice profile:', profiles.map((vp) => ({
                    label: vp.name,
                    detail: vp.description || '',
                    value: vp.id,
                  })));
                  opts.voiceProfile = vpChoice.value;
                }
              } catch {
                // Voice profiles optional, continue without
              }
            }
          }

          // Interactive: custom name
          if (!opts.name) {
            const nameInput = await ask(rl, chalk.cyan('  Custom name (Enter to skip): '));
            if (nameInput.trim()) {
              opts.name = nameInput.trim();
            }
          }
        } finally {
          rl.close();
        }
      }

      // Build hire payload
      const body = {};
      if (opts.name) body.name = opts.name;
      if (opts.voiceProfile) body.voice_profile_id = opts.voiceProfile;
      if (opts.accounts) body.account_ids = opts.accounts.split(',').map((s) => s.trim());

      const spinner = ora(`Hiring ${presetId}...`).start();
      try {
        const result = await client.hirePreset(presetId, body);
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printSection('Agent Hired');
        console.log(chalk.green(`  ✓ ${result.agent?.name || presetId}`));
        if (result.agent) {
          console.log(chalk.gray(`    ID: ${result.agent.id}`));
          console.log(chalk.gray(`    Type: ${result.agent.type}`));
          console.log(chalk.gray(`    Status: ${result.agent.status}`));
        }
        if (result.job) {
          console.log();
          console.log(chalk.bold('  Default job created:'));
          console.log(chalk.gray(`    Name: ${result.job.name}`));
          console.log(chalk.gray(`    ID: ${result.job.id}`));
          console.log(chalk.gray(`    Status: ${result.job.status}`));
        }
        if (result.api_key) {
          console.log();
          console.log(chalk.yellow.bold('  ⚠ API Key (save this now — it won\'t be shown again):'));
          console.log(chalk.yellow(`    ${result.api_key}`));
        }
        console.log();
      } catch (err) {
        spinner.fail(`Failed to hire: ${err.message}`);
        process.exit(1);
      }
    });

  // ── agent enable ────────────────────────────────────────────────────────

  agent
    .command('enable')
    .argument('<agent>', 'Agent ID, name, or slug')
    .description('Enable (activate) an agent')
    .action(async (agentQuery) => {
      await toggleAgent(agentQuery, 'active');
    });

  // ── agent disable ───────────────────────────────────────────────────────

  agent
    .command('disable')
    .argument('<agent>', 'Agent ID, name, or slug')
    .description('Disable (pause) an agent')
    .action(async (agentQuery) => {
      await toggleAgent(agentQuery, 'paused');
    });
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function buildClient() {
  const config = new Config();
  const client = new BoltaAPIClient(config);
  const validation = client.validate();
  if (!validation.ok) {
    console.error(chalk.red(`  ✗ ${validation.error}`));
    process.exit(1);
  }
  return client;
}

async function toggleAgent(agentQuery, newStatus) {
  const client = buildClient();
  const spinner = ora('Fetching agents...').start();

  try {
    const data = await client.getAgentsV2();
    const agents = data.results || data.agents || data || [];
    const agent = findAgent(Array.isArray(agents) ? agents : [], agentQuery);

    if (!agent) {
      spinner.fail(`Agent not found: ${agentQuery}`);
      process.exit(1);
    }

    spinner.text = `${newStatus === 'active' ? 'Enabling' : 'Disabling'} ${agent.name}...`;
    await client.updateAgent(agent.id, { status: newStatus });
    spinner.succeed(`${agent.name} is now ${statusBadge(newStatus)}`);
  } catch (err) {
    spinner.fail(`Error: ${err.message}`);
    process.exit(1);
  }
}
