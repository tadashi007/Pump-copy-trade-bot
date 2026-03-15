/**
 * Pump.fun Copy Trade Bot — Entry Point
 *
 * Flow:
 *   WalletListener (WS logsSubscribe)
 *     → signature
 *       → PumpDecoder (getTransaction + BorshCoder IDL decode)
 *         → DetectedBuy
 *           → TradeExecutor (program.methods.buy())
 *             → Position
 *               → ExitManager (poll TP/SL → program.methods.sell())
 */

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { createLogger, getLogger } from './logger.js';
import { WalletListener } from './listener/walletListener.js';
import { decodeTransaction } from './decoder/pumpDecoder.js';
import { TradeExecutor } from './executor/tradeExecutor.js';
import { ExitManager } from './exit/exitManager.js';
import { TerminalDashboard } from './dashboard/terminalDashboard.js';

async function main(): Promise<void> {
  const config = loadConfig();
  createLogger(config.logLevel);
  const log = getLogger();

  if (config.simulationMode) {
    log.info('========================================');
    log.info('   SIMULATION MODE — no real trades');
    log.info('========================================');
  }

  log.info('Pump.fun Copy Trade Bot starting', {
    simulationMode:  config.simulationMode,
    mirrorExit:      config.mirrorExit,
    migrationExit:   config.enableMigrationExit,
    targetWallet:    config.targetWallet.toBase58(),
    ourWallet:       config.wallet.publicKey.toBase58(),
    buyAmountSol:    config.buyAmountSol,
    slippageBps:     config.slippageBps,
    priorityFee:     config.priorityFeeMicroLamports,
    stopLossPct:     config.stopLossPct,
    takeProfitPct:   config.takeProfitPct,
  });

  const connection = new Connection(config.rpcHttp, { commitment: 'confirmed' });
  const executor   = new TradeExecutor(connection, config.wallet, config);
  let startingBalanceLamports = 0n;

  try {
    const bal = await connection.getBalance(config.wallet.publicKey, 'confirmed');
    startingBalanceLamports = BigInt(bal);
  } catch (err) {
    log.warn('Failed to fetch startup balance; defaulting to 0', {
      error: (err as Error).message,
    });
  }

  const dashboard = new TerminalDashboard(
    startingBalanceLamports,
    config.wallet.publicKey.toBase58(),
    config.simulationMode,
  );

  const exitMgr    = new ExitManager(connection, executor, config, (trade) => {
    dashboard.addClosedTrade(trade);
  });

  // Set of mints currently being processed for entry to prevent duplicate concurrent buys.
  const pendingBuyMints = new Set<string>();

  // Queue of pending signatures to process (prevents concurrent decode of same sig)
  let processing = false;
  const queue: string[] = [];

  function scheduleQueueDrain(): void {
    processQueue().catch((err) =>
      getLogger().error('processQueue threw', { error: (err as Error).message }),
    );
  }

  async function processQueue(): Promise<void> {
    if (processing) return;
    processing = true;

    try {
      while (queue.length > 0) {
        const signature = queue.shift()!;
        await handleSignature(signature);
      }
    } finally {
      processing = false;
      if (queue.length > 0) {
        scheduleQueueDrain();
      }
    }
  }

  async function handleSignature(signature: string): Promise<void> {
    const log = getLogger();

    try {
      const detected = await decodeTransaction(connection, signature, config.targetWallet);
      if (!detected) return;

      const mintKey = detected.mint.toBase58();

      if (detected.kind === 'sell') {
        if (config.mirrorExit && exitMgr.hasPosition(mintKey)) {
          await exitMgr.triggerMirrorExit(mintKey);
        }
        return;
      }

      if (pendingBuyMints.has(mintKey)) {
        log.info('Buy already in flight — skipping duplicate signal', { mint: mintKey, signature });
        return;
      }

      // Skip if we already have an open position in this token
      if (exitMgr.hasPosition(mintKey)) {
        log.info('Already holding position — skipping', { mint: mintKey });
        return;
      }

      pendingBuyMints.add(mintKey);

      try {
        const position = await executor.executeBuy(detected);
        if (!position) {
          return;
        }

        exitMgr.addPosition(position);
      } finally {
        pendingBuyMints.delete(mintKey);
      }
    } catch (err) {
      log.error('Error handling signature', {
        signature,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
    }
  }

  // Start exit manager polling
  exitMgr.start();

  // Start WebSocket listener
  const listener = new WalletListener(
    config.rpcWss,
    config.targetWallet,
    (signature) => {
      queue.push(signature);
      scheduleQueueDrain();
    },
  );

  listener.start();

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log.info(`Received ${signal} — shutting down`);
    listener.stop();
    exitMgr.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { error: err.message, stack: err.stack });
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', { reason: String(reason) });
  });

  log.info('Bot is running — waiting for target wallet transactions');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
