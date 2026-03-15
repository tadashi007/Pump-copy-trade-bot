import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { getLogger } from '../logger.js';

export type SignatureCallback = (signature: string) => void;

interface LogsNotification {
  jsonrpc: string;
  method: string;
  params: {
    result: {
      value: {
        signature: string;
        err: unknown;
        logs: string[];
      };
      context: { slot: number };
    };
    subscription: number;
  };
}

const RECONNECT_DELAY_MS = 2_000;
const PING_INTERVAL_MS   = 25_000;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Monitors a single target wallet via WebSocket `logsSubscribe` (mentions filter).
 * Emits transaction signatures for every confirmed transaction that mentions the wallet.
 * Handles reconnects with exponential backoff, pings to keep the connection alive,
 * and clean shutdown.
 */
export class WalletListener {
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopped = false;
  private onSignature: SignatureCallback;

  constructor(
    private readonly wssUrl: string,
    private readonly targetWallet: PublicKey,
    onSignature: SignatureCallback,
  ) {
    this.onSignature = onSignature;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    getLogger().info('WalletListener stopped');
  }

  private connect(): void {
    const log = getLogger();
    log.info('WalletListener connecting', {
      url: redactWsUrl(this.wssUrl),
      target: this.targetWallet.toBase58(),
    });

    const ws = new WebSocket(this.wssUrl);
    this.ws = ws;

    ws.once('open', () => {
      this.reconnectAttempts = 0;
      log.info('WalletListener WebSocket open — subscribing to logs');
      this.subscribe(ws);
      this.startPing(ws);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      this.handleMessage(raw.toString());
    });

    ws.once('close', (code, reason) => {
      this.clearTimers();
      if (!this.stopped) {
        log.warn('WalletListener WebSocket closed — will reconnect', {
          code,
          reason: reason.toString(),
        });
        this.scheduleReconnect();
      }
    });

    ws.once('error', (err) => {
      log.error('WalletListener WebSocket error', { error: (err as Error).message });
      // 'close' fires after 'error', reconnect handled there
    });
  }

  private subscribe(ws: WebSocket): void {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [this.targetWallet.toBase58()] },
        { commitment: 'confirmed' },
      ],
    });
    ws.send(payload);
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // Subscription confirmation
    if ('id' in msg && 'result' in msg && typeof msg.result === 'number') {
      this.subscriptionId = msg.result as number;
      getLogger().info('WalletListener subscribed', { subscriptionId: this.subscriptionId });
      return;
    }

    // Log notification
    if (msg.method !== 'logsNotification') return;

    const notification = msg as unknown as LogsNotification;
    const value = notification.params?.result?.value;
    if (!value) return;

    // Skip failed transactions immediately
    if (value.err !== null && value.err !== undefined) return;

    this.onSignature(value.signature);
  }

  private startPing(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      getLogger().error('WalletListener exceeded max reconnect attempts — giving up');
      return;
    }
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1), 30_000);
    getLogger().info('WalletListener scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

function redactWsUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    if (url.username) url.username = '***';
    if (url.password) url.password = '***';

    for (const key of ['api-key', 'apikey', 'token', 'key']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '***');
      }
    }

    return url.toString();
  } catch {
    return rawUrl.replace(/((?:api[-_]?key|token|key)=)[^&]+/gi, '$1***');
  }
}
