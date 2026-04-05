/**
 * `boltaclaw presets` — List available agent presets from the marketplace.
 */

import chalk from 'chalk';
import ora from 'ora';
import { Config } from '../config.js';
import { BoltaAPIClient } from '../api-client.js';
import { printSection, printTable } from '../tui.js';

export function registerPresetsCommand(program) {
  program
    .command('presets')
    .description('List available agent presets from the marketplace')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const config = new Config();
      const client = new BoltaAPIClient(config);
      const validation = client.validate();
      if (!validation.ok) {
        console.error(chalk.red(`  ✗ ${validation.error}`));
        process.exit(1);
      }

      const spinner = ora('Fetching presets...').start();
      try {
        const data = await client.getPresets();
        spinner.stop();

        const presets = (data.presets || []).filter((p) => !p.comingSoon);

        if (opts.json) {
          console.log(JSON.stringify(presets, null, 2));
          return;
        }

        printSection('Agent Presets');

        if (presets.length === 0) {
          console.log(chalk.gray('  No presets available.'));
          return;
        }

        printTable(
          ['ID', 'Name', 'Type', 'Tagline'],
          presets.map((p) => [
            chalk.cyan(p.id || p.slug),
            p.name,
            p.type,
            chalk.gray(p.tagline || ''),
          ])
        );

        console.log();
        console.log(chalk.gray('  Hire a preset: boltaclaw agent hire <preset-id>'));
        console.log();
      } catch (err) {
        spinner.fail(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
