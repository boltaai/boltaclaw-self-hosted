/**
 * Telegram Webhook Listener for BoltaClaw
 *
 * Minimal HTTP server (Node built-in) that receives Telegram updates
 * via webhook and forwards them to the Bridge for agent execution.
 *
 * Flow:
 *   Telegram → [HTTPS webhook] → TelegramWebhook → onMessage callback → Bridge → Agent
 *   Agent result → sendReply → Telegram
 */

import { createServer } from 'http';
import { request as httpsRequest } from 'https';

const TG_API = 'https://api.telegram.org';

function telegramPost(token, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${TG_API}/bot${token}/${method}`);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks));
          } catch {
            resolve({ ok: false, description: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export class TelegramWebhook {
  /**
   * @param {import('./config.js').Config} config
   * @param {object} opts
   * @param {number} [opts.port=8080]
   * @param {string} [opts.publicUrl] - Public HTTPS URL for webhook registration
   * @param {(msg: {chatId: number, userId: number, text: string, username?: string}) => Promise<string|void>} opts.onMessage
   * @param {boolean} [opts.verbose=false]
   */
  constructor(config, opts = {}) {
    this.config = config;
    this.port = opts.port || 8080;
    this.publicUrl = opts.publicUrl || config.get('TELEGRAM_WEBHOOK_URL') || '';
    this.onMessage = opts.onMessage || (() => {});
    this.verbose = opts.verbose || false;
    this.server = null;
    this._token = config.get('TELEGRAM_BOT_TOKEN');
    this._allowedUserId = config.get('TELEGRAM_USER_ID')
      ? parseInt(config.get('TELEGRAM_USER_ID'), 10)
      : null;
  }

  async start() {
    if (!this._token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    // Start HTTP server
    this.server = createServer((req, res) => this._handleRequest(req, res));

    await new Promise((resolve, reject) => {
      this.server.listen(this.port, () => resolve());
      this.server.on('error', reject);
    });

    if (this.verbose) {
      console.log(`  📡 Telegram webhook server listening on port ${this.port}`);
    }

    // Register webhook with Telegram if we have a public URL
    if (this.publicUrl) {
      const webhookUrl = `${this.publicUrl.replace(/\/$/, '')}/telegram/webhook`;
      const result = await telegramPost(this._token, 'setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message'],
      });

      if (result.ok) {
        console.log(`  ✅ Telegram webhook registered: ${webhookUrl}`);
      } else {
        console.error(`  ❌ Failed to register webhook: ${result.description}`);
      }
    } else {
      console.log('  ⚠ No public URL configured — Telegram webhook not registered');
      console.log('    Set TELEGRAM_WEBHOOK_URL or pass --telegram-url');
    }

    return this;
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }

    // Optionally delete the webhook on shutdown
    if (this._token) {
      try {
        await telegramPost(this._token, 'deleteWebhook', {});
        if (this.verbose) console.log('  🧹 Telegram webhook removed');
      } catch {
        // Best-effort cleanup
      }
    }
  }

  /**
   * Send a text reply to a Telegram chat.
   */
  async sendReply(chatId, text) {
    if (!this._token) return;
    return telegramPost(this._token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
  }

  // --- Internal ---

  _handleRequest(req, res) {
    if (req.method === 'POST' && req.url === '/telegram/webhook') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        this._processUpdate(body);
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'boltaclaw-telegram' }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  async _processUpdate(rawBody) {
    try {
      const update = JSON.parse(rawBody);
      const message = update.message;
      if (!message || !message.text) return;

      const chatId = message.chat.id;
      const userId = message.from?.id;
      const username = message.from?.username || '';
      const text = message.text;

      // Security: allowlist check
      if (this._allowedUserId && userId !== this._allowedUserId) {
        if (this.verbose) {
          console.log(`  🚫 Telegram: rejected message from user ${userId} (not in allowlist)`);
        }
        return;
      }

      if (this.verbose) {
        console.log(`  💬 Telegram: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" from @${username}`);
      }

      // Forward to Bridge via callback
      const reply = await this.onMessage({ chatId, userId, text, username });

      // If the callback returns a string, send it as a reply
      if (typeof reply === 'string' && reply.length > 0) {
        await this.sendReply(chatId, reply);
      }
    } catch (err) {
      console.error(`  ❌ Telegram webhook error: ${err.message}`);
    }
  }
}
