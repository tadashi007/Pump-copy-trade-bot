import { Connection } from '@solana/web3.js';
import { getLogger } from '../logger.js';
import { ClosedTrade, ExitReason, Position } from '../types.js';
import { TradeExecutor, deriveBondingCurvePda, pricePerTokenLamports } from '../executor/tradeExecutor.js';
import { fetchBondingCurve } from '../decoder/pumpDecoder.js';
import { Config } from '../config.js';

/**
 * Polls all open positions and executes take-profit or stop-loss sells
 * when price targets are hit.
 *
 * Architecture: polling every `exitPollIntervalMs` ms.
 * Each position is checked independently; a failed check does not block others.
 */
export class ExitManager {
  private positions = new Map<string, Position>(); // keyed by mint base58
  private migratedHoldLogged = new Set<string>(); // avoid repeated warn spam per mint
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly connection: Connection,
    private readonly executor: TradeExecutor,
    private readonly config: Config,
    private readonly onTradeClosed?: (trade: ClosedTrade) => void,
  ) {}

  /** Register a new open position for monitoring. */
  addPosition(position: Position): void {
    const key = position.mint.toBase58();
    if (this.positions.has(key)) {
      getLogger().warn('Position already tracked — overwriting', { mint: key });
    }
    this.positions.set(key, position);
    this.migratedHoldLogged.delete(key);
    getLogger().info('Position added to exit monitor', {
      mint: key,
      entryPricePerToken: position.entryPricePerToken.toString(),
      takeProfitPrice:    position.takeProfitPrice.toString(),
      stopLossPrice:      position.stopLossPrice.toString(),
      tokenAmount:        position.tokenAmount.toString(),
    });
  }

  /** Remove a position (called after a successful sell). */
  removePosition(mintBase58: string): void {
    this.positions.delete(mintBase58);
    this.migratedHoldLogged.delete(mintBase58);
  }

  hasPosition(mintBase58: string): boolean {
    return this.positions.has(mintBase58);
  }

  async triggerMirrorExit(mintBase58: string): Promise<void> {
    const position = this.positions.get(mintBase58);
    if (!position) return;
    getLogger().info('Mirror exit signal received — selling', { mint: mintBase58 });
    await this.executeAndHandleExit(mintBase58, position, 'mirror');
  }

  positionCount(): number {
    return this.positions.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll();
    getLogger().info('ExitManager started', { pollIntervalMs: this.config.exitPollIntervalMs });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    getLogger().info('ExitManager stopped');
  }

  private scheduleNextPoll(): void {
    this.timer = setTimeout(async () => {
      if (!this.running) return;
      await this.poll();
      if (this.running) this.scheduleNextPoll();
    }, this.config.exitPollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.positions.size === 0) return;

    const log = getLogger();
    const entries = [...this.positions.entries()];

    await Promise.allSettled(
      entries.map(([mintBase58, position]) =>
        this.checkPosition(mintBase58, position).catch((err) => {
          log.error('ExitManager position check threw', {
            mint: mintBase58,
            error: (err as Error).message,
          });
        }),
      ),
    );
  }

  private async checkPosition(mintBase58: string, position: Position): Promise<void> {
    const log = getLogger();
    const bondingCurvePda = deriveBondingCurvePda(position.mint);

    const curve = await fetchBondingCurve(this.connection, bondingCurvePda);
    if (!curve) {
      log.warn('Could not fetch bonding curve for position check — will retry', { mint: mintBase58 });
      return;
    }

    // Token migrated from Pump bonding curve.
    // Do not auto-exit on migration; keep position open for mirror/manual handling.
    if (curve.complete) {
      if (!this.migratedHoldLogged.has(mintBase58)) {
        this.migratedHoldLogged.add(mintBase58);
        log.warn('Token graduated — holding position (auto-exit on migration disabled)', {
          mint: mintBase58,
        });
      }
      return;
    }

    const currentPrice = pricePerTokenLamports(curve);

    const isTakeProfit = this.config.mirrorExit ? false : currentPrice >= position.takeProfitPrice;
    const isStopLoss   = currentPrice <= position.stopLossPrice;

    if (!isTakeProfit && !isStopLoss) {
      log.debug('Position within range', {
        mint: mintBase58,
        currentPrice: currentPrice.toString(),
        tp: position.takeProfitPrice.toString(),
        sl: position.stopLossPrice.toString(),
      });
      return;
    }

    const reason: ExitReason = isTakeProfit ? 'take-profit' : 'stop-loss';

    log.info('Exit condition met — selling', {
      reason,
      mint: mintBase58,
      currentPrice: currentPrice.toString(),
      entryPrice:   position.entryPricePerToken.toString(),
      pnlPct: formatPnlPct(currentPrice, position.entryPricePerToken),
    });

    await this.executeAndHandleExit(mintBase58, position, reason);
  }

  private async executeAndHandleExit(
    mintBase58: string,
    position: Position,
    reason: ExitReason,
  ): Promise<void> {
    const log = getLogger();

    // Remove before selling to prevent a second concurrent sell attempt
    this.removePosition(mintBase58);

    const result = await this.executor.executeSell(position, reason);
    if (result.success) {
      log.info('Exit sell confirmed', { reason, mint: mintBase58, signature: result.signature });

      const exitLamports = result.expectedSolOutLamports ?? 0n;
      const pnlLamports = exitLamports - position.entryLamports;
      const pnlPct = position.entryLamports > 0n
        ? Number((pnlLamports * 10_000n) / position.entryLamports) / 100
        : 0;

      this.onTradeClosed?.({
        mint: mintBase58,
        reason,
        tokenAmount: position.tokenAmount,
        entryLamports: position.entryLamports,
        exitLamports,
        pnlLamports,
        pnlPct,
        signature: result.signature,
        closedAt: Date.now(),
      });
    } else {
      log.error('Exit sell failed', { reason, mint: mintBase58, error: result.error });
      // Re-add position so we retry on next poll cycle
      this.addPosition(position);
    }
  }
}

function formatPnlPct(current: bigint, entry: bigint): string {
  if (entry === 0n) return 'n/a';
  return ((Number(current) / Number(entry) - 1) * 100).toFixed(2) + '%';
}
