import chalk from 'chalk';

const BANNER = [
  ' ____        _ _             _                ',
  '| __ )  ___ | | |_ __ _  ___| | __ ___      __',
  "|  _ \\ / _ \\| | __/ _` |/ __| |/ _` \\ \\ /\\ / /",
  '| |_) | (_) | | || (_| | (__| | (_| |\\ V  V / ',
  '|____/ \\___/|_|\\__\\__,_|\\___|_|\\__,_| \\_/\\_/  ',
];

export function printBanner(subtitle = 'OpenClaw Engine') {
  for (const line of BANNER) {
    console.log(chalk.cyan(line));
  }
  console.log(chalk.gray(`  ${subtitle}`));
  console.log();
}

export function printSection(title) {
  console.log(chalk.blue.bold(`\n  ${title}\n`));
}

export function printKeyValue(label, value, width = 16) {
  const key = `${label}:`.padEnd(width, ' ');
  console.log(`  ${key}${value}`);
}

/**
 * Print a simple table with headers and rows.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function printTable(headers, rows) {
  if (rows.length === 0) {
    console.log(chalk.gray('  (none)'));
    return;
  }

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] || '').length))
  );

  // Header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(chalk.bold(`  ${headerLine}`));
  console.log(chalk.gray(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`));

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => {
      const pad = widths[i] - stripAnsi(cell || '').length;
      return (cell || '') + ' '.repeat(Math.max(0, pad));
    }).join('  ');
    console.log(`  ${line}`);
  }
}

/**
 * Format a status string with color.
 */
export function statusBadge(status) {
  switch (status) {
    case 'active': return chalk.green('active');
    case 'paused': return chalk.yellow('paused');
    case 'error': return chalk.red('error');
    case 'completed': return chalk.blue('completed');
    default: return chalk.gray(status || 'unknown');
  }
}

/**
 * Strip ANSI escape codes for width calculation.
 */
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
