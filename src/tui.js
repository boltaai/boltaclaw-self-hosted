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
