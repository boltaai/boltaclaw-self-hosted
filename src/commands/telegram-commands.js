/**
 * Telegram command parser for agent/job management.
 *
 * Intercepts messages starting with `/` and routes to the appropriate
 * API call. Returns { handled, reply } — if handled is false, the
 * message should pass through to the agent as normal.
 */

/**
 * Handle a Telegram command message.
 *
 * @param {string} text - The message text
 * @param {import('../api-client.js').BoltaAPIClient} client - API client
 * @returns {Promise<{ handled: boolean, reply?: string }>}
 */
export async function handleTelegramCommand(text, client) {
  if (!text || !text.startsWith('/')) {
    return { handled: false };
  }

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname
  const args = parts.slice(1);

  try {
    switch (cmd) {
      case '/help':
        return { handled: true, reply: formatHelp() };

      case '/presets':
        return { handled: true, reply: await cmdPresets(client) };

      case '/hire':
        return { handled: true, reply: await cmdHire(client, args) };

      case '/agents':
        return { handled: true, reply: await cmdAgents(client) };

      case '/enable':
        return { handled: true, reply: await cmdToggleAgent(client, args, 'active') };

      case '/disable':
        return { handled: true, reply: await cmdToggleAgent(client, args, 'paused') };

      case '/jobs':
        return { handled: true, reply: await cmdJobs(client, args) };

      case '/status':
        return { handled: true, reply: await cmdStatus(client) };

      default:
        // Unknown slash command — pass through to agent
        return { handled: false };
    }
  } catch (err) {
    return { handled: true, reply: `❌ Error: ${err.message}` };
  }
}

// ─── Command implementations ────────────────────────────────────────────────

function formatHelp() {
  return [
    '🤖 BoltaClaw Commands',
    '',
    '/presets — List available agent presets',
    '/hire <preset> — Hire an agent preset',
    '/agents — List your hired agents',
    '/enable <agent> — Enable an agent',
    '/disable <agent> — Disable an agent',
    '/jobs [agent] — List jobs',
    '/status — Runner overview',
    '/help — Show this help',
  ].join('\n');
}

async function cmdPresets(client) {
  const data = await client.getPresets();
  const presets = (data.presets || []).filter((p) => !p.comingSoon);

  if (presets.length === 0) return 'No presets available.';

  const lines = ['📋 Available Presets', ''];
  for (const p of presets) {
    lines.push(`${p.emoji || '•'} ${p.name} — ${p.tagline || p.type}`);
    lines.push(`  ID: ${p.id || p.slug}`);
  }
  lines.push('');
  lines.push('Hire one: /hire <id>');
  return lines.join('\n');
}

async function cmdHire(client, args) {
  if (args.length === 0) {
    return '❌ Usage: /hire <preset-id>\n\nUse /presets to see available IDs.';
  }

  const presetId = args[0];
  const name = args.slice(1).join(' ') || undefined;
  const body = {};
  if (name) body.name = name;

  const result = await client.hirePreset(presetId, body);

  const lines = [`✅ Hired: ${result.agent?.name || presetId}`];
  if (result.agent) {
    lines.push(`Type: ${result.agent.type}`);
    lines.push(`Status: ${statusEmoji(result.agent.status)} ${result.agent.status}`);
  }
  if (result.job) {
    lines.push('');
    lines.push(`📋 Default job: ${result.job.name}`);
    lines.push(`Status: ${statusEmoji(result.job.status)} ${result.job.status}`);
  }
  if (result.api_key) {
    lines.push('');
    lines.push(`⚠️ API Key (save now): ${result.api_key}`);
  }
  return lines.join('\n');
}

async function cmdAgents(client) {
  const data = await client.getAgentsV2();
  const agents = data.results || data.agents || data || [];

  if (!Array.isArray(agents) || agents.length === 0) {
    return 'No agents hired yet.\n\nUse /hire <preset> to get started.';
  }

  const lines = ['🤖 Your Agents', ''];
  for (const a of agents) {
    lines.push(`${statusEmoji(a.status)} ${a.name} (${a.type || a.slug})`);
    lines.push(`  ID: ${a.id?.slice(0, 8)}  Status: ${a.status}`);
  }
  return lines.join('\n');
}

async function cmdToggleAgent(client, args, newStatus) {
  if (args.length === 0) {
    return `❌ Usage: /${newStatus === 'active' ? 'enable' : 'disable'} <agent-name-or-id>`;
  }

  const query = args.join(' ');
  const data = await client.getAgentsV2();
  const agents = data.results || data.agents || data || [];
  const agent = findAgent(Array.isArray(agents) ? agents : [], query);

  if (!agent) {
    return `❌ Agent not found: ${query}\n\nUse /agents to see your agents.`;
  }

  await client.updateAgent(agent.id, { status: newStatus });
  return `${statusEmoji(newStatus)} ${agent.name} is now ${newStatus}`;
}

async function cmdJobs(client, args) {
  const agentsData = await client.getAgentsV2();
  const agents = agentsData.results || agentsData.agents || agentsData || [];

  let targetAgents = Array.isArray(agents) ? agents : [];
  if (args.length > 0) {
    const query = args.join(' ');
    const found = findAgent(targetAgents, query);
    if (!found) return `❌ Agent not found: ${query}`;
    targetAgents = [found];
  }

  const allJobs = [];
  for (const agent of targetAgents) {
    try {
      const jobsData = await client.getJobs(agent.id);
      const jobs = jobsData.results || jobsData.jobs || jobsData || [];
      for (const j of (Array.isArray(jobs) ? jobs : [])) {
        allJobs.push({ ...j, _agentName: agent.name });
      }
    } catch {
      // Skip
    }
  }

  if (allJobs.length === 0) return 'No jobs found.';

  const lines = ['📋 Jobs', ''];
  for (const j of allJobs) {
    lines.push(`${statusEmoji(j.status)} ${j.name || '(unnamed)'} — ${j._agentName}`);
    const sched = j.schedule?.cron || j.schedule?.frequency || '—';
    lines.push(`  Trigger: ${j.trigger || 'scheduled'}  Schedule: ${sched}`);
  }
  return lines.join('\n');
}

async function cmdStatus(client) {
  const data = await client.getStatus();
  const lines = ['📊 Runner Status', ''];
  lines.push(`Workspace: ${data.workspace_id || '—'}`);

  if (data.agents?.length) {
    lines.push('');
    lines.push('Agents:');
    for (const a of data.agents) {
      lines.push(`  ${statusEmoji(a.status)} ${a.name} (${a.slug || a.type})`);
    }
  }

  if (data.accounts?.length) {
    lines.push('');
    lines.push('Accounts:');
    for (const a of data.accounts) {
      lines.push(`  ${a.platform}: @${a.username}`);
    }
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function statusEmoji(status) {
  switch (status) {
    case 'active': return '🟢';
    case 'paused': return '🟡';
    case 'error': return '🔴';
    case 'completed': return '🔵';
    default: return '⚪';
  }
}

function findAgent(agents, query) {
  const lower = query.toLowerCase();
  return agents.find(
    (a) =>
      a.id === query ||
      a.id?.startsWith(query) ||
      (a.name && a.name.toLowerCase() === lower) ||
      (a.slug && a.slug.toLowerCase() === lower)
  );
}
