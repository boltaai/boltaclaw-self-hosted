/**
 * `boltaclaw job` — Job management commands.
 *
 * Subcommands: list, create, enable, disable
 */

import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { Config } from '../config.js';
import { BoltaAPIClient } from '../api-client.js';
import { printSection, printTable, statusBadge } from '../tui.js';
import { SCHEDULE_PRESETS, resolveSchedule } from '../schedule-presets.js';

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function findAgent(agents, query) {
  const lower = query.toLowerCase();
  return agents.find(
    (a) =>
      a.id === query ||
      (a.name && a.name.toLowerCase() === lower) ||
      (a.slug && a.slug.toLowerCase() === lower)
  );
}

function summarizeSchedule(schedule) {
  if (!schedule) return chalk.gray('—');
  if (schedule.cron) return schedule.cron;
  const parts = [];
  if (schedule.frequency) parts.push(schedule.frequency);
  if (schedule.days) parts.push(schedule.days.join(', '));
  if (schedule.time) parts.push(schedule.time);
  return parts.join(' ') || chalk.gray('—');
}

// ─── Command registration ───────────────────────────────────────────────────

export function registerJobCommands(program) {
  const job = program
    .command('job')
    .description('Manage jobs (list, create, enable, disable)');

  // ── job list ────────────────────────────────────────────────────────────

  job
    .command('list')
    .description('List jobs across agents')
    .option('--agent <agent>', 'Filter by agent ID, name, or slug')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const client = buildClient();
      const spinner = ora('Fetching jobs...').start();

      try {
        const agentsData = await client.getAgentsV2();
        const agents = agentsData.results || agentsData.agents || agentsData || [];

        let targetAgents = Array.isArray(agents) ? agents : [];
        if (opts.agent) {
          const found = findAgent(targetAgents, opts.agent);
          if (!found) {
            spinner.fail(`Agent not found: ${opts.agent}`);
            process.exit(1);
          }
          targetAgents = [found];
        }

        const allJobs = [];
        for (const agent of targetAgents) {
          try {
            const jobsData = await client.getJobs(agent.id);
            const jobs = jobsData.results || jobsData.jobs || jobsData || [];
            for (const j of (Array.isArray(jobs) ? jobs : [])) {
              allJobs.push({ ...j, _agentName: agent.name, _agentId: agent.id });
            }
          } catch {
            // Skip agents we can't fetch jobs for
          }
        }

        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(allJobs, null, 2));
          return;
        }

        printSection('Jobs');

        if (allJobs.length === 0) {
          console.log(chalk.gray('  No jobs found.'));
          console.log(chalk.gray('  Create one: boltaclaw job create <agent>'));
          console.log();
          return;
        }

        printTable(
          ['Job Name', 'Agent', 'Trigger', 'Schedule', 'Status', 'ID'],
          allJobs.map((j) => [
            j.name || chalk.gray('(unnamed)'),
            j._agentName,
            j.trigger || 'scheduled',
            summarizeSchedule(j.schedule),
            statusBadge(j.status),
            chalk.gray(j.id?.slice(0, 8) || ''),
          ])
        );
        console.log();
      } catch (err) {
        spinner.fail(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── job create ──────────────────────────────────────────────────────────

  job
    .command('create')
    .argument('<agent>', 'Agent ID, name, or slug')
    .description('Create a new job on an agent')
    .option('--name <name>', 'Job name')
    .option('--schedule <preset>', 'Schedule preset or cron (daily, weekday-mornings, twice-daily, weekly, 3x-week, or cron)')
    .option('--voice-profile <id>', 'Voice profile ID')
    .option('--accounts <ids>', 'Comma-separated account IDs')
    .option('--config <json>', 'Trigger config as JSON')
    .option('--instructions <text>', 'Run instructions')
    .option('--json', 'Output raw JSON')
    .action(async (agentQuery, opts) => {
      const client = buildClient();

      // Resolve agent
      const spinner = ora('Resolving agent...').start();
      let agent;
      try {
        const agentsData = await client.getAgentsV2();
        const agents = agentsData.results || agentsData.agents || agentsData || [];
        agent = findAgent(Array.isArray(agents) ? agents : [], agentQuery);
        if (!agent) {
          spinner.fail(`Agent not found: ${agentQuery}`);
          process.exit(1);
        }
        spinner.stop();
      } catch (err) {
        spinner.fail(`Error: ${err.message}`);
        process.exit(1);
      }

      let jobName = opts.name;
      let scheduleInput = opts.schedule;

      // Interactive prompts for missing fields
      if (!jobName || !scheduleInput) {
        const rl = createPrompt();
        try {
          if (!jobName) {
            jobName = await ask(rl, chalk.cyan('  Job name: '));
            if (!jobName.trim()) {
              console.log(chalk.red('  Job name is required.'));
              process.exit(1);
            }
            jobName = jobName.trim();
          }

          if (!scheduleInput) {
            const scheduleOptions = Object.entries(SCHEDULE_PRESETS).map(([key, val]) => ({
              label: key,
              detail: val.label,
              value: key,
            }));
            scheduleOptions.push({ label: 'custom', detail: 'Enter a cron expression', value: '_custom' });

            const chosen = await promptChoice(rl, 'Choose a schedule:', scheduleOptions);
            if (chosen.value === '_custom') {
              scheduleInput = await ask(rl, chalk.cyan('  Cron expression: '));
            } else {
              scheduleInput = chosen.value;
            }
          }
        } finally {
          rl.close();
        }
      }

      // Build payload
      const { schedule } = resolveSchedule(scheduleInput);
      const payload = {
        name: jobName,
        trigger: 'scheduled',
        status: 'active',
        schedule,
      };

      if (opts.voiceProfile) payload.voice_profile_id = opts.voiceProfile;
      if (opts.accounts) payload.account_ids = opts.accounts.split(',').map((s) => s.trim());
      if (opts.instructions) payload.run_instructions = opts.instructions;
      if (opts.config) {
        try {
          payload.trigger_config = JSON.parse(opts.config);
        } catch {
          console.error(chalk.red('  ✗ Invalid JSON for --config'));
          process.exit(1);
        }
      }

      const createSpinner = ora(`Creating job on ${agent.name}...`).start();
      try {
        const result = await client.createJob(agent.id, payload);
        createSpinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printSection('Job Created');
        console.log(chalk.green(`  ✓ ${result.name || jobName}`));
        console.log(chalk.gray(`    Agent: ${agent.name}`));
        console.log(chalk.gray(`    ID: ${result.id}`));
        console.log(chalk.gray(`    Schedule: ${summarizeSchedule(result.schedule || schedule)}`));
        console.log(chalk.gray(`    Status: ${result.status}`));
        console.log();
      } catch (err) {
        createSpinner.fail(`Failed to create job: ${err.message}`);
        process.exit(1);
      }
    });

  // ── job enable ──────────────────────────────────────────────────────────

  job
    .command('enable')
    .argument('<job-id>', 'Job ID')
    .description('Enable (activate) a job')
    .requiredOption('--agent <agent>', 'Agent ID, name, or slug')
    .action(async (jobId, opts) => {
      await toggleJob(jobId, opts.agent, 'active');
    });

  // ── job disable ─────────────────────────────────────────────────────────

  job
    .command('disable')
    .argument('<job-id>', 'Job ID')
    .description('Disable (pause) a job')
    .requiredOption('--agent <agent>', 'Agent ID, name, or slug')
    .action(async (jobId, opts) => {
      await toggleJob(jobId, opts.agent, 'paused');
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

async function toggleJob(jobId, agentQuery, newStatus) {
  const client = buildClient();
  const spinner = ora('Resolving agent...').start();

  try {
    const agentsData = await client.getAgentsV2();
    const agents = agentsData.results || agentsData.agents || agentsData || [];
    const agent = findAgent(Array.isArray(agents) ? agents : [], agentQuery);

    if (!agent) {
      spinner.fail(`Agent not found: ${agentQuery}`);
      process.exit(1);
    }

    spinner.text = `${newStatus === 'active' ? 'Enabling' : 'Disabling'} job...`;
    await client.updateJob(agent.id, jobId, { status: newStatus });
    spinner.succeed(`Job ${jobId.slice(0, 8)} is now ${statusBadge(newStatus)}`);
  } catch (err) {
    spinner.fail(`Error: ${err.message}`);
    process.exit(1);
  }
}
