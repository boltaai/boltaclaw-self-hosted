#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
const BOLTACLAW_HOME = path.join(HOME, '.boltaclaw');
const ENGINE_DIR = path.join(BOLTACLAW_HOME, 'engine');
const SKILLS_DIR = path.join(BOLTACLAW_HOME, 'skills');
const BIN_DIR = path.join(BOLTACLAW_HOME, 'bin');
const CONFIG_FILE = path.join(BOLTACLAW_HOME, 'config.json');
const OC_DIR = path.join(HOME, '.openclaw-bolta');
const OC_BIN = path.join(OC_DIR, 'node_modules', '.bin', 'openclaw');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function has(cmd) {
  const r = runCapture('bash', ['-lc', `command -v ${cmd}`]);
  return r.status === 0;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function writeConfig(patch) {
  ensureDir(BOLTACLAW_HOME);
  const cur = readConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
}

function ensureNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Node.js 22+ required. Current: v${process.versions.node}`);
    process.exit(1);
  }
}

function ensureGit() {
  if (!has('git')) {
    console.error('git is required but not found in PATH');
    process.exit(1);
  }
}

function cloneOrUpdate(repo, dir) {
  if (fs.existsSync(path.join(dir, '.git'))) {
    run('git', ['-C', dir, 'pull', '--ff-only']);
  } else {
    run('git', ['clone', '--depth', '1', repo, dir]);
  }
}

function ensureOpenClaw() {
  ensureDir(OC_DIR);
  if (!fs.existsSync(path.join(OC_DIR, 'package.json'))) {
    fs.writeFileSync(path.join(OC_DIR, 'package.json'), JSON.stringify({ name: 'openclaw-bolta', private: true }, null, 2));
  }
  run('npm', ['install', '--save', 'openclaw@latest'], { cwd: OC_DIR });
  if (!fs.existsSync(OC_BIN)) {
    console.error(`OpenClaw install failed. Missing binary: ${OC_BIN}`);
    process.exit(1);
  }
}

function ensureWrapper() {
  ensureDir(BIN_DIR);
  const wrapper = path.join(BIN_DIR, 'boltaclaw');
  const content = `#!/usr/bin/env bash\nexec node "$HOME/.boltaclaw/engine/src/cli.js" "$@"\n`;
  fs.writeFileSync(wrapper, content, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
}

function ensureInstall() {
  ensureNode22();
  ensureGit();
  ensureDir(BOLTACLAW_HOME);

  // If this command is already running from ~/.boltaclaw/engine, don't reclone over itself
  const runningFromEngine = __filename.startsWith(ENGINE_DIR);
  if (!runningFromEngine) {
    cloneOrUpdate('https://github.com/boltaai/boltaclaw-self-hosted.git', ENGINE_DIR);
    run('npm', ['install', '--omit=dev'], { cwd: ENGINE_DIR });
  }

  ensureOpenClaw();
  ensureWrapper();
  cloneOrUpdate('https://github.com/boltaai/bolta-skills.git', SKILLS_DIR);
}

function maybeAddPathHint() {
  const shellRc = fs.existsSync(path.join(HOME, '.zshrc')) ? path.join(HOME, '.zshrc') : path.join(HOME, '.bashrc');
  const line = 'export PATH="$HOME/.boltaclaw/bin:$PATH"';
  let txt = '';
  try { txt = fs.readFileSync(shellRc, 'utf8'); } catch {}
  if (!txt.includes('.boltaclaw/bin')) {
    fs.appendFileSync(shellRc, `\n# BoltaClaw\n${line}\n`);
    console.log(`Added PATH entry to ${shellRc}`);
  }
}

function cmdStart(args) {
  const tokenArg = args.find(a => a.startsWith('--token='));
  const token = tokenArg ? tokenArg.slice('--token='.length) : undefined;

  ensureInstall();
  maybeAddPathHint();

  if (token) {
    writeConfig({ token, updated_at: new Date().toISOString() });
    console.log('Saved token to ~/.boltaclaw/config.json');
  }

  if (!fs.existsSync(OC_BIN)) {
    console.error('OpenClaw not installed correctly.');
    process.exit(1);
  }

  console.log('Starting OpenClaw gateway...');
  run(OC_BIN, ['gateway', 'start']);

  console.log('\nDone. Next commands:');
  console.log('  boltaclaw status');
  console.log('  boltaclaw logs');
}

function cmdSetup() {
  ensureInstall();
  maybeAddPathHint();
  console.log('Setup complete. Run: boltaclaw start --token=YOUR_TOKEN');
}

function cmdStatus() {
  const cfg = readConfig();
  console.log(`Engine: ${fs.existsSync(ENGINE_DIR) ? 'installed' : 'missing'}`);
  console.log(`OpenClaw: ${fs.existsSync(OC_BIN) ? 'installed' : 'missing'}`);
  console.log(`Skills: ${fs.existsSync(SKILLS_DIR) ? 'installed' : 'missing'}`);
  console.log(`Token: ${cfg.token ? 'set' : 'missing'}`);
  if (fs.existsSync(OC_BIN)) run(OC_BIN, ['gateway', 'status']);
}

function cmdLogs(args) {
  if (!fs.existsSync(OC_BIN)) {
    console.error('OpenClaw not installed. Run: boltaclaw setup');
    process.exit(1);
  }
  const follow = args.includes('-f') || args.includes('--follow');
  const cmd = follow ? 'openclaw gateway status && openclaw status' : 'openclaw status';
  run('bash', ['-lc', `${OC_BIN} gateway status && ${OC_BIN} status`]);
}

function cmdUpdate() {
  ensureInstall();
  if (fs.existsSync(OC_BIN)) run(OC_BIN, ['gateway', 'restart']);
  console.log('Update complete.');
}

function usage() {
  console.log(`BoltaClaw\n\nUsage:\n  boltaclaw setup\n  boltaclaw start --token=YOUR_TOKEN\n  boltaclaw status\n  boltaclaw logs [-f]\n  boltaclaw update\n\nTip: run via npx:\n  npx boltaclaw start --token=YOUR_TOKEN`);
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'start': cmdStart(args); break;
  case 'setup': cmdSetup(); break;
  case 'status': cmdStatus(); break;
  case 'logs': cmdLogs(args); break;
  case 'update': cmdUpdate(); break;
  case '--help':
  case '-h':
  case undefined: usage(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
