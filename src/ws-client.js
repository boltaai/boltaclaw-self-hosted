import WebSocket from 'ws';
import { EventEmitter } from 'events';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]; // Backoff

export class WSClient extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.headers = opts.headers || {};
    this.verbose = opts.verbose || false;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempt = 0;
    this.shouldReconnect = true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url, {
        headers: this.headers,
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      });

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        if (this.verbose) console.log('  WS connected');
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type) {
            this.emit(msg.type, msg.data || {});
          }
        } catch (err) {
          console.error('  WS parse error:', err.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        console.log(`  ⚠ WS closed: code=${code} reason=${reason?.toString() || 'none'}`);
        if (this.shouldReconnect) this._reconnect();
      });

      this.ws.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          console.error('  WS error:', err.message);
        }
      });
    });
  }

  send(type, data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  async close() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close(1000, 'shutdown');
    }
  }

  _reconnect() {
    const delay = RECONNECT_DELAYS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
    ];
    this.reconnectAttempt++;

    if (this.verbose) {
      console.log(`  WS reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);
    }

    setTimeout(async () => {
      try {
        await this.connect();
        this.emit('reconnected');
      } catch {
        // connect() failed, will trigger close → _reconnect again
      }
    }, delay);
  }
}
