import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function parsePrivateKey(raw: string): Keypair {
  try {
    const bytes = bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('PRIVATE_KEY must be a base58-encoded secret key');
  }
}

function parsePublicKey(raw: string, field: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${field} must be a valid base58-encoded Solana public key`);
  }
}

export interface Config {
  simulationMode: boolean;
  rpcHttp: string;
  rpcWss: string;
  mirrorExit: boolean;
  enableMigrationExit: boolean;
  jupiterQuoteUrl: string;
  jupiterSwapUrl: string;
  wallet: Keypair;
  targetWallet: PublicKey;
  buyAmountSol: number;
  slippageBps: number;
  priorityFeeMicroLamports: number;
  stopLossPct: number;
  takeProfitPct: number;
  exitPollIntervalMs: number;
  logLevel: string;
}

export function loadConfig(): Config {
  const simulationMode = process.env.SIMULATION_MODE === 'true';

  // In simulation mode, PRIVATE_KEY is optional — generate a throwaway keypair
  const wallet = process.env.PRIVATE_KEY
    ? parsePrivateKey(process.env.PRIVATE_KEY)
    : simulationMode
      ? Keypair.generate()
      : (() => { throw new Error('PRIVATE_KEY is required when SIMULATION_MODE is not true'); })();

  return {
    simulationMode,
    rpcHttp:                  requireEnv('RPC_HTTP'),
    rpcWss:                   requireEnv('RPC_WSS'),
    mirrorExit:               process.env.MIRROR_EXIT !== 'false',
    enableMigrationExit:      process.env.ENABLE_MIGRATION_EXIT !== 'false',
    jupiterQuoteUrl:          process.env.JUPITER_QUOTE_URL ?? 'https://lite-api.jup.ag/swap/v1/quote',
    jupiterSwapUrl:           process.env.JUPITER_SWAP_URL ?? 'https://lite-api.jup.ag/swap/v1/swap',
    wallet,
    targetWallet:             parsePublicKey(requireEnv('TARGET_WALLET'), 'TARGET_WALLET'),
    buyAmountSol:             parseFloat(process.env.BUY_AMOUNT_SOL ?? '0.01'),
    slippageBps:              parseInt(process.env.SLIPPAGE_BPS ?? '500', 10),
    priorityFeeMicroLamports: parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS ?? '100000', 10),
    stopLossPct:              parseFloat(process.env.STOP_LOSS_PCT ?? '40'),
    takeProfitPct:            parseFloat(process.env.TAKE_PROFIT_PCT ?? '50'),
    exitPollIntervalMs:       parseInt(process.env.EXIT_POLL_INTERVAL_MS ?? '5000', 10),
    logLevel:                 process.env.LOG_LEVEL ?? 'info',
  };
}
