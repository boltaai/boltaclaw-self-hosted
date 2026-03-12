/**
 * Bolta API client for CLI commands.
 *
 * Thin HTTP client that calls the Bolta server API using API key auth.
 * Supports SSE streaming for agent run responses.
 */

const DEFAULT_API_BASE = 'https://platty.boltathread.com/api/v1';

export class BoltaAPIClient {
  constructor(config) {
    this.config = config;
    this.apiBase = config.get('api_base') || process.env.BOLTA_API_BASE || DEFAULT_API_BASE;
    this.apiKey = config.get('bolta_api_key') || process.env.BOLTA_API_KEY;
    this.workspaceId = config.get('workspace_id');
  }

  /**
   * Validate that API key and workspace are configured.
   * Returns { ok: true } or { ok: false, error: string }.
   */
  validate() {
    if (!this.apiKey) {
      return {
        ok: false,
        error: 'No API key configured. Run: boltaclaw config set bolta_api_key YOUR_KEY',
      };
    }
    if (!this.workspaceId) {
      return {
        ok: false,
        error: 'No workspace configured. Run: boltaclaw config set workspace_id YOUR_WORKSPACE_ID',
      };
    }
    return { ok: true };
  }

  /**
   * Make an authenticated API request.
   */
  async request(method, path, body = null) {
    const url = `${this.apiBase}/${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const opts = { method, headers };
    if (body) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    if (!res.ok) {
      const text = await res.text();
      let detail;
      try {
        detail = JSON.parse(text);
      } catch {
        detail = { error: text };
      }
      throw new APIError(res.status, detail.error || detail.message || text);
    }

    return res.json();
  }

  /**
   * Stream an SSE response from the CLI run endpoint.
   * Yields parsed event objects: { event: string, data: object }
   *
   * @param {string} message - The prompt to send
   * @param {object} opts - Options: { agent?, history?, trace_id? }
   * @param {function} onEvent - Callback for each SSE event
   */
  async streamRun(message, opts = {}, onEvent) {
    const url = `${this.apiBase}/workspaces/${this.workspaceId}/cli/run`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const body = {
      message,
      ...(opts.agent && { agent: opts.agent }),
      ...(opts.history && { history: opts.history }),
      ...(opts.trace_id && { trace_id: opts.trace_id }),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new APIError(res.status, text);
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (separated by double newline)
      const events = buffer.split('\n\n');
      buffer = events.pop(); // Keep incomplete event in buffer

      for (const eventStr of events) {
        if (!eventStr.trim()) continue;

        const parsed = parseSSEEvent(eventStr);
        if (parsed && onEvent) {
          onEvent(parsed);
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const parsed = parseSSEEvent(buffer);
      if (parsed && onEvent) {
        onEvent(parsed);
      }
    }
  }

  /**
   * GET workspace status (agents, accounts, recent runs).
   */
  async getStatus() {
    return this.request('GET', `workspaces/${this.workspaceId}/cli/status`);
  }

  /**
   * GET list of agents in the workspace.
   */
  async getAgents() {
    return this.request('GET', `workspaces/${this.workspaceId}/conductor/agents`);
  }
}


/**
 * Parse a single SSE event string into { event, data }.
 */
function parseSSEEvent(str) {
  let eventType = 'message';
  let dataStr = '';

  for (const line of str.split('\n')) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataStr = line.slice(6);
    }
  }

  if (!dataStr) return null;

  try {
    return { event: eventType, data: JSON.parse(dataStr) };
  } catch {
    return { event: eventType, data: { raw: dataStr } };
  }
}


class APIError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}
