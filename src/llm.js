/**
 * Shared LLM provider/model resolution for cloud config sync.
 */

const PROVIDER_ALIASES = {
  claude: 'claude',
  anthropic: 'claude',
  openai: 'openai',
  gemini: 'gemini',
  google: 'gemini',
};

export const PROVIDER_ENV_KEYS = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
};

// Keep these in sync with provider docs and prefer stable production IDs.
export const PROVIDER_DEFAULT_MODELS = {
  claude: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-5.3-codex',
  gemini: 'google/gemini-3.1-flash-lite',
};

export function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'string') return null;
  return PROVIDER_ALIASES[provider.toLowerCase()] || null;
}

export function resolveProviderConfig({ provider, model = null } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return { provider: null, envKey: null, model: null };
  }

  const envKey = PROVIDER_ENV_KEYS[normalizedProvider] || null;
  const resolvedModel = (typeof model === 'string' && model.trim())
    ? model.trim()
    : PROVIDER_DEFAULT_MODELS[normalizedProvider] || null;

  return {
    provider: normalizedProvider,
    envKey,
    model: resolvedModel,
  };
}
