import {
  Connection,
  PublicKey,
  VersionedTransactionResponse,
  MessageAccountKeys,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getLogger } from '../logger.js';
import { DetectedSignal, BondingCurveState, GlobalState } from '../types.js';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
const TX_FETCH_MAX_ATTEMPTS = 12;
const TX_FETCH_BASE_DELAY_MS = 250;

// Account index positions within buy instruction accounts array (from IDL order)
const BUY_ACCOUNT_IDX = {
  global:                 0,
  feeRecipient:           1,
  mint:                   2,
  bondingCurve:           3,
  associatedBondingCurve: 4,
  associatedUser:         5,
  user:                   6,
} as const;

const SELL_ACCOUNT_IDX = {
  global:                 0,
  feeRecipient:           1,
  mint:                   2,
  bondingCurve:           3,
  associatedBondingCurve: 4,
  associatedUser:         5,
  user:                   6,
} as const;

// Offsets into BondingCurve account data (after 8-byte discriminator)
const BC_OFFSET = {
  virtualTokenReserves: 8,
  virtualSolReserves:   16,
  realTokenReserves:    24,
  realSolReserves:      32,
  tokenTotalSupply:     40,
  complete:             48,
  creator:              49,  // 32 bytes
} as const;

// Offsets into Global account data (after 8-byte discriminator)
const GLOBAL_OFFSET = {
  initialized:                   8,
  authority:                     9,   // 32 bytes
  feeRecipient:                  41,  // 32 bytes
  initialVirtualTokenReserves:   73,
  initialVirtualSolReserves:     81,
  initialRealTokenReserves:      89,
  tokenTotalSupply:              97,
  feeBasisPoints:                105,
} as const;

interface CompiledInstructionLike {
  programIdIndex: number;
  data: Uint8Array | string;
  accountKeyIndexes?: number[];
  accounts?: number[];
}

/**
 * Fetches a confirmed transaction and decodes it.
 * Returns a detected pump.fun buy/sell signal for the target wallet.
 * Returns null if not relevant.
 */
export async function decodeTransaction(
  connection: Connection,
  signature: string,
  targetWallet: PublicKey,
): Promise<DetectedSignal | null> {
  const log = getLogger();

  let tx: VersionedTransactionResponse | null = null;
  for (let attempt = 1; attempt <= TX_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx) break;
    } catch (err) {
      log.debug('getTransaction attempt failed', { signature, attempt, error: (err as Error).message });
    }

    if (attempt < TX_FETCH_MAX_ATTEMPTS) {
      const delayMs = Math.min(TX_FETCH_BASE_DELAY_MS * 2 ** (attempt - 1), 2_000);
      await sleep(delayMs);
    }
  }

  if (!tx) {
    log.debug('Could not fetch transaction after retries', {
      signature,
      attempts: TX_FETCH_MAX_ATTEMPTS,
    });
    return null;
  }

  // Skip failed transactions
  if (tx.meta?.err) return null;

  const accountKeys = resolveAccountKeys(tx);
  const compiledInstructions = collectInstructions(tx);

  for (const ix of compiledInstructions) {
    const programKey = accountKeys.get(ix.programIdIndex);
    if (!programKey || !programKey.equals(PUMP_PROGRAM_ID)) continue;

    const rawData = (ix as { data: Uint8Array | string }).data;
    const dataBuffer = decodeInstructionData(rawData);

    // Discriminator check first (fast path)
    if (dataBuffer.length < 8) continue;
    const isBuy = dataBuffer.subarray(0, 8).equals(BUY_DISCRIMINATOR);
    const isSell = dataBuffer.subarray(0, 8).equals(SELL_DISCRIMINATOR);
    if (!isBuy && !isSell) continue;

    // Pump payload begins with:
    // [8-byte discriminator][u64 amount][u64 max_sol_cost/min_sol_output][...optional future fields]
    if (dataBuffer.length < 24) {
      log.debug('Pump payload too short', { signature, payloadLen: dataBuffer.length });
      continue;
    }
    const tokenAmount = dataBuffer.readBigUInt64LE(8);

    // Resolve accounts from the instruction's account index list
    const ixAccounts = ix.accountKeyIndexes ?? ix.accounts;
    if (!ixAccounts || ixAccounts.length === 0) {
      log.debug('Buy instruction had no account indexes', { signature });
      continue;
    }

    const getAccount = (slot: number): PublicKey | null => {
      const idx = ixAccounts[slot];
      return idx !== undefined ? (accountKeys.get(idx) ?? null) : null;
    };

    const accountIdx = isBuy ? BUY_ACCOUNT_IDX : SELL_ACCOUNT_IDX;
    const user        = getAccount(accountIdx.user);
    const mint        = getAccount(accountIdx.mint);
    const bondingCurve = getAccount(accountIdx.bondingCurve);
    const targetWalletInIx = ixAccounts.some((idx) => accountKeys.get(idx)?.equals(targetWallet));

    if (!mint || !bondingCurve) {
      log.debug('Missing expected accounts in buy instruction', { signature });
      continue;
    }

    // Primary path: `user` account equals target wallet.
    // Fallback path: target wallet is present anywhere in this ix account list.
    if (!user?.equals(targetWallet) && !targetWalletInIx) continue;

    const actor = user ?? targetWallet;
    if (isBuy) {
      const maxSolCost = dataBuffer.readBigUInt64LE(16);

      log.info('Detected pump.fun buy', {
        signature,
        mint: mint.toBase58(),
        buyer: actor.toBase58(),
        tokenAmount: tokenAmount.toString(),
        maxSolCost: maxSolCost.toString(),
      });

      return {
        kind: 'buy',
        signature,
        mint,
        buyer: actor,
        tokenAmount,
        maxSolCost,
        bondingCurve,
        detectedAt: Date.now(),
      };
    }

    const minSolOutput = dataBuffer.readBigUInt64LE(16);

    log.info('Detected pump.fun sell', {
      signature,
      mint: mint.toBase58(),
      seller: actor.toBase58(),
      tokenAmount: tokenAmount.toString(),
      minSolOutput: minSolOutput.toString(),
    });

    return {
      kind: 'sell',
      signature,
      mint,
      seller: actor,
      tokenAmount,
      minSolOutput,
      bondingCurve,
      detectedAt: Date.now(),
    };
  }

  log.debug('No pump trade signal decoded from transaction', { signature });
  return null;
}

/**
 * Reads and deserializes a BondingCurve account from chain.
 */
export async function fetchBondingCurve(
  connection: Connection,
  bondingCurvePda: PublicKey,
): Promise<BondingCurveState | null> {
  const info = await connection.getAccountInfo(bondingCurvePda, 'confirmed');
  if (!info || info.data.length < 81) return null;

  const d = info.data;
  return {
    virtualTokenReserves: d.readBigUInt64LE(BC_OFFSET.virtualTokenReserves),
    virtualSolReserves:   d.readBigUInt64LE(BC_OFFSET.virtualSolReserves),
    realTokenReserves:    d.readBigUInt64LE(BC_OFFSET.realTokenReserves),
    realSolReserves:      d.readBigUInt64LE(BC_OFFSET.realSolReserves),
    tokenTotalSupply:     d.readBigUInt64LE(BC_OFFSET.tokenTotalSupply),
    complete:             d[BC_OFFSET.complete] === 1,
    creator:              new PublicKey(d.subarray(BC_OFFSET.creator, BC_OFFSET.creator + 32)),
  };
}

/**
 * Reads and deserializes the Global state account from chain.
 */
export async function fetchGlobalState(
  connection: Connection,
  globalPda: PublicKey,
): Promise<GlobalState | null> {
  const info = await connection.getAccountInfo(globalPda, 'confirmed');
  if (!info || info.data.length < 113) return null;

  const d = info.data;
  return {
    initialized:                d[GLOBAL_OFFSET.initialized] === 1,
    authority:                  new PublicKey(d.subarray(GLOBAL_OFFSET.authority, GLOBAL_OFFSET.authority + 32)),
    feeRecipient:               new PublicKey(d.subarray(GLOBAL_OFFSET.feeRecipient, GLOBAL_OFFSET.feeRecipient + 32)),
    initialVirtualTokenReserves:d.readBigUInt64LE(GLOBAL_OFFSET.initialVirtualTokenReserves),
    initialVirtualSolReserves:  d.readBigUInt64LE(GLOBAL_OFFSET.initialVirtualSolReserves),
    initialRealTokenReserves:   d.readBigUInt64LE(GLOBAL_OFFSET.initialRealTokenReserves),
    tokenTotalSupply:           d.readBigUInt64LE(GLOBAL_OFFSET.tokenTotalSupply),
    feeBasisPoints:             d.readBigUInt64LE(GLOBAL_OFFSET.feeBasisPoints),
  };
}

/**
 * Resolves all account keys from a transaction (handles v0 + legacy).
 */
function resolveAccountKeys(tx: VersionedTransactionResponse): MessageAccountKeys {
  const msg = tx.transaction.message;
  if ('getAccountKeys' in msg) {
    return msg.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? { writable: [], readonly: [] },
    });
  }
  // Legacy message — wrap accountKeys array in a compatible shape
  const keys = (msg as { accountKeys: PublicKey[] }).accountKeys;
  return {
    get: (i: number) => keys[i] ?? null,
    length: keys.length,
    staticAccountKeys: keys,
    accountKeysFromLookups: undefined,
    keySegments: () => [keys],
  } as unknown as MessageAccountKeys;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function collectInstructions(tx: VersionedTransactionResponse): CompiledInstructionLike[] {
  const message = tx.transaction.message;
  const topLevel = (
    'compiledInstructions' in message
      ? message.compiledInstructions
      : (message as { instructions: { programIdIndex: number; accounts: number[]; data: string }[] }).instructions
  ) as CompiledInstructionLike[];

  const inner = (tx.meta?.innerInstructions ?? []).flatMap((entry) =>
    (entry.instructions as { programIdIndex: number; accounts: number[]; data: string }[]).map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: ix.accounts,
      data: ix.data,
    })),
  );

  return [...topLevel, ...inner];
}

function decodeInstructionData(raw: Uint8Array | string): Buffer {
  if (typeof raw !== 'string') {
    return Buffer.from(raw);
  }

  // RPC JSON message instruction data is usually base58 for legacy transactions.
  try {
    return Buffer.from(bs58.decode(raw));
  } catch {
    // Fallback for providers/encodings that return base64.
    return Buffer.from(raw, 'base64');
  }
}
