/**
 * Job Executor
 *
 * Receives a job from Bolta Cloud via WebSocket, executes it using
 * the configured LLM (Claude by default, BYOK), and returns results.
 *
 * Execution flow:
 * 1. Load agent preset + skills for the given agent_slug
 * 2. Build system prompt with workspace context (brand voice, accounts, etc.)
 * 3. Call Claude API with tools from bolta-skills
 * 4. Stream progress events back via onProgress callback
 * 5. Return final output
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export class Executor {
  constructor(config, db) {
    this.config = config;
    this.db = db;
  }

  async execute({ jobId, agentSlug, input, context, onProgress }) {
    const apiKey = this.config.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured. Run: boltaclaw config set ANTHROPIC_API_KEY sk-ant-...');
    }

    // Load agent preset
    const preset = this._getPreset(agentSlug);

    // Build system prompt
    const systemPrompt = this._buildSystemPrompt(preset, context);

    // Build messages
    const messages = [{ role: 'user', content: input }];

    // Stream progress: starting
    onProgress?.({ type: 'status', message: `${preset.name} is thinking...` });

    // Call Claude API
    const response = await this._callClaude(apiKey, systemPrompt, messages, onProgress);

    return response;
  }

  _getPreset(slug) {
    // TODO: Load from bolta-skills repo or local presets
    const presets = {
      hunter: { name: 'Hunter', role: 'Content Discovery & Trending Topics' },
      hype_man: { name: 'Hype Man', role: 'Viral Content & Engagement' },
      deep_diver: { name: 'Deep Diver', role: 'Long-form Research & Analysis' },
      guardian: { name: 'Guardian', role: 'Brand Safety & Compliance' },
      analyst: { name: 'Analyst', role: 'Performance Analytics & Insights' },
      engager: { name: 'Engager', role: 'Community & Reply Management' },
      reply_specialist: { name: 'Reply Specialist', role: 'Smart Replies & Conversations' },
      storyteller: { name: 'Storyteller', role: 'Narrative & Brand Storytelling' },
    };
    return presets[slug] || { name: slug, role: 'General Agent' };
  }

  _buildSystemPrompt(preset, context) {
    let prompt = `You are ${preset.name}, a Bolta AI agent specializing in ${preset.role}.\n\n`;

    if (context?.workspace) {
      prompt += `## Workspace Context\n${JSON.stringify(context.workspace, null, 2)}\n\n`;
    }

    if (context?.voice_profile) {
      prompt += `## Voice Profile\nWrite in this voice: ${context.voice_profile}\n\n`;
    }

    if (context?.memory) {
      prompt += `## Memory\n${context.memory}\n\n`;
    }

    return prompt;
  }

  async _callClaude(apiKey, systemPrompt, messages, onProgress) {
    const body = {
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    };

    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const output = data.content?.[0]?.text || '';

    onProgress?.({ type: 'complete', message: 'Done' });

    return { text: output, model: data.model, usage: data.usage };
  }
}
