import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import crypto from 'crypto';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import anchor from '@coral-xyz/anchor';
import type { AnchorProvider as AnchorProviderType, Idl, Program as AnchorProgram, Wallet } from '@coral-xyz/anchor';
import { getLogger } from '../logger.js';
import { fetchBondingCurve, fetchGlobalState } from '../decoder/pumpDecoder.js';
import { Config } from '../config.js';
import { DetectedBuy, BondingCurveState, ExecutionResult, ExitReason, Position } from '../types.js';
import pumpIdlJson from '../idl/pump.json' with { type: 'json' };

const { AnchorProvider, Program, BN } = anchor;

// ── Constants ────────────────────────────────────────────────────────────────

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const FEE_PROGRAM_ID  = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// Hard-coded second seed for fee_config PDA (from official IDL)
const FEE_CONFIG_SEED_2 = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104,
  191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59,
  101, 93, 43, 182, 253, 109, 24, 176,
]);

const COMPUTE_UNITS = 200_000;
// Pump.fun bonding curve fee in basis points
const PUMP_FEE_BPS = 100n;
// Fixed-point scale for price-per-token math to avoid truncating to 0 lamports.
const PRICE_SCALE = 1_000_000_000n;
const JUPITER_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

interface JupiterQuoteResponse {
  outAmount: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
}

// ── PDA derivations ──────────────────────────────────────────────────────────

export function deriveGlobalPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM_ID)[0];
}

export function deriveBondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

export function deriveCreatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

export function deriveEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_PROGRAM_ID,
  )[0];
}

export function deriveGlobalVolumeAccumulatorPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_PROGRAM_ID,
  )[0];
}

export function deriveUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

export function deriveFeeConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), FEE_CONFIG_SEED_2],
    FEE_PROGRAM_ID,
  )[0];
}

// ── Price math ───────────────────────────────────────────────────────────────

/**
 * Calculates how many tokens you receive when spending `solLamports` on the bonding curve.
 * Uses the constant-product AMM formula with pump.fun's 1% fee applied before curve.
 */
export function calculateTokensOut(
  curve: BondingCurveState,
  solLamports: bigint,
): bigint {
  const netSol = (solLamports * (10_000n - PUMP_FEE_BPS)) / 10_000n;
  const k      = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newVsr = curve.virtualSolReserves + netSol;
  const newVtr = k / newVsr;
  return curve.virtualTokenReserves - newVtr;
}

/**
 * Calculates how much SOL you receive when selling `tokenAmount` tokens.
 * Inverse of the constant-product formula, after the 1% sell fee.
 */
export function calculateSolOut(
  curve: BondingCurveState,
  tokenAmount: bigint,
): bigint {
  const k      = curve.virtualSolReserves * curve.virtualTokenReserves;
  const newVtr = curve.virtualTokenReserves + tokenAmount;
  const newVsr = k / newVtr;
  const grossSol = curve.virtualSolReserves - newVsr;
  return (grossSol * (10_000n - PUMP_FEE_BPS)) / 10_000n;
}

/** Market cap in lamports = price × total supply */
export function calculateMarketCapLamports(curve: BondingCurveState): bigint {
  // price per token (lamports) = virtualSolReserves / virtualTokenReserves
  return (curve.virtualSolReserves * curve.tokenTotalSupply) / curve.virtualTokenReserves;
}

/** Price per token as fixed-point lamports scaled by PRICE_SCALE */
export function pricePerTokenLamports(curve: BondingCurveState): bigint {
  if (curve.virtualTokenReserves === 0n) return 0n;
  return (curve.virtualSolReserves * PRICE_SCALE) / curve.virtualTokenReserves;
}

// ── Token program detection ──────────────────────────────────────────────────

async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// ── Main executor ────────────────────────────────────────────────────────────

export class TradeExecutor {
  private program: AnchorProgram;
  private provider: AnchorProviderType;
  private globalPda: PublicKey;
  private eventAuthorityPda: PublicKey;
  private globalVolumeAccumulatorPda: PublicKey;
  private feeConfigPda: PublicKey;
  /** Cached feeRecipient from Global state (refreshed on first use and every hour) */
  private feeRecipient: PublicKey | null = null;
  private feeRecipientFetchedAt = 0;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Keypair,
    private readonly config: Config,
  ) {
    // Anchor provider wraps the connection + wallet
    const anchorWallet: Wallet = {
      publicKey: wallet.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        if (tx instanceof Transaction) {
          tx.sign(wallet);
        } else {
          tx.sign([wallet]);
        }
        return tx;
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
        txs.forEach((t) => {
          if (t instanceof Transaction) {
            t.sign(wallet);
          } else {
            t.sign([wallet]);
          }
        });
        return txs;
      },
      payer: wallet,
    };

    this.provider = new AnchorProvider(connection, anchorWallet, { commitment: 'confirmed' });
    this.program   = new Program(pumpIdlJson as Idl, this.provider);

    this.globalPda                 = deriveGlobalPda();
    this.eventAuthorityPda         = deriveEventAuthorityPda();
    this.globalVolumeAccumulatorPda = deriveGlobalVolumeAccumulatorPda();
    this.feeConfigPda              = deriveFeeConfigPda();
  }

  /**
   * Executes a copy-buy for the given detected buy signal.
   * Returns the position if successful, null if skipped.
   */
  async executeBuy(detected: DetectedBuy): Promise<Position | null> {
    const log = getLogger();
    const { mint, bondingCurve: bondingCurvePda } = detected;

    // ── Fetch on-chain state ──────────────────────────────────────────────
    const [curve, feeRecipient, balance] = await Promise.all([
      fetchBondingCurve(this.connection, bondingCurvePda),
      this.getOrFetchFeeRecipient(),
      this.connection.getBalance(this.wallet.publicKey, 'confirmed'),
    ]);

    if (!curve) {
      log.warn('BondingCurve not found — skipping', { mint: mint.toBase58() });
      return null;
    }

    // ── Pre-flight checks ────────────────────────────────────────────────
    if (curve.complete) {
      log.info('Token already migrated — skipping', { mint: mint.toBase58() });
      return null;
    }

    const marketCapSol = Number(calculateMarketCapLamports(curve)) / LAMPORTS_PER_SOL;

    const buyLamports = BigInt(Math.floor(this.config.buyAmountSol * LAMPORTS_PER_SOL));
    const minRequiredBalance = buyLamports + 10_000_000n; // 0.01 SOL reserve for rent/fees
    if (!this.config.simulationMode && BigInt(balance) < minRequiredBalance) {
      log.warn('Insufficient balance — skipping', {
        balance: (balance / LAMPORTS_PER_SOL).toFixed(4),
        needed: (Number(minRequiredBalance) / LAMPORTS_PER_SOL).toFixed(4),
      });
      return null;
    }

    // ── Calculate amounts ─────────────────────────────────────────────────
    const tokenAmount = calculateTokensOut(curve, buyLamports);
    if (tokenAmount === 0n) {
      log.warn('Token amount calculated as 0 — skipping');
      return null;
    }

    const maxSolCost = (buyLamports * (10_000n + BigInt(this.config.slippageBps))) / 10_000n;

    // ── Derive accounts ───────────────────────────────────────────────────
    const tokenProgram              = await detectTokenProgram(this.connection, mint);
    const creatorVaultPda           = deriveCreatorVaultPda(curve.creator);
    const userVolumeAccumulatorPda  = deriveUserVolumeAccumulatorPda(this.wallet.publicKey);
    const associatedBondingCurve    = getAssociatedTokenAddressSync(mint, bondingCurvePda, true, tokenProgram);
    const associatedUser            = getAssociatedTokenAddressSync(mint, this.wallet.publicKey, false, tokenProgram);

    log.info('Executing buy', {
      mint: mint.toBase58(),
      tokenAmount: tokenAmount.toString(),
      spendingSol: this.config.buyAmountSol,
      maxSolCost: (Number(maxSolCost) / LAMPORTS_PER_SOL).toFixed(6),
      marketCapSol: marketCapSol.toFixed(2),
    });

    // ── Build transaction ──────────────────────────────────────────────────
    const buyTx = await this.program.methods
      .buy(
        new BN(tokenAmount.toString()),
        new BN(maxSolCost.toString()),
        { none: {} }, // track_volume: OptionBool::None
      )
      .accounts({
        global:                  this.globalPda,
        feeRecipient:            feeRecipient,
        mint:                    mint,
        bondingCurve:            bondingCurvePda,
        associatedBondingCurve:  associatedBondingCurve,
        associatedUser:          associatedUser,
        user:                    this.wallet.publicKey,
        systemProgram:           SystemProgram.programId,
        tokenProgram:            tokenProgram,
        creatorVault:            creatorVaultPda,
        eventAuthority:          this.eventAuthorityPda,
        program:                 PUMP_PROGRAM_ID,
        globalVolumeAccumulator: this.globalVolumeAccumulatorPda,
        userVolumeAccumulator:   userVolumeAccumulatorPda,
        feeConfig:               this.feeConfigPda,
        feeProgram:              FEE_PROGRAM_ID,
      })
      .transaction();

    // Prepend: create user ATA (idempotent) + ComputeBudget
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.priorityFeeMicroLamports }),
      createAssociatedTokenAccountIdempotentInstruction(
        this.wallet.publicKey, // payer
        associatedUser,
        this.wallet.publicKey, // owner
        mint,
        tokenProgram,
      ),
      ...buyTx.instructions,
    );

    // ── Send & confirm (or simulate) ────────────────────────────────────
    if (this.config.simulationMode) {
      const simSig = `SIM_BUY_${crypto.randomBytes(16).toString('hex')}`;
      log.info('[SIMULATION] Buy would execute', {
        mint: mint.toBase58(),
        tokenAmount: tokenAmount.toString(),
        spendingSol: this.config.buyAmountSol,
        maxSolCost: (Number(maxSolCost) / LAMPORTS_PER_SOL).toFixed(6),
        marketCapSol: marketCapSol.toFixed(2),
        simulatedSignature: simSig,
        instructionCount: tx.instructions.length,
      });

      const entryPrice = pricePerTokenLamports(curve);
      const tpPrice    = entryPrice * (100n + BigInt(Math.floor(this.config.takeProfitPct))) / 100n;
      const slPrice    = entryPrice * (100n - BigInt(Math.floor(this.config.stopLossPct)))  / 100n;

      return {
        mint,
        tokenAmount,
        entryLamports:     buyLamports,
        entryPricePerToken: entryPrice,
        enteredAt:         Date.now(),
        takeProfitPrice:   tpPrice,
        stopLossPrice:     slPrice,
      };
    }

    const result = await this.sendWithRetry(tx);
    if (!result.success) {
      log.error('Buy transaction failed', { mint: mint.toBase58(), error: result.error });
      return null;
    }

    log.info('Buy confirmed', { mint: mint.toBase58(), signature: result.signature });

    const entryPrice = pricePerTokenLamports(curve);
    const tpPrice    = entryPrice * (100n + BigInt(Math.floor(this.config.takeProfitPct))) / 100n;
    const slPrice    = entryPrice * (100n - BigInt(Math.floor(this.config.stopLossPct)))  / 100n;

    return {
      mint,
      tokenAmount,
      entryLamports:     buyLamports,
      entryPricePerToken: entryPrice,
      enteredAt:         Date.now(),
      takeProfitPrice:   tpPrice,
      stopLossPrice:     slPrice,
    };
  }

  /**
   * Executes a sell for the given position.
   */
  async executeSell(position: Position, reason: ExitReason): Promise<ExecutionResult> {
    const log = getLogger();
    const { mint } = position;

    const bondingCurvePda = deriveBondingCurvePda(mint);
    const [curve, feeRecipient] = await Promise.all([
      fetchBondingCurve(this.connection, bondingCurvePda),
      this.getOrFetchFeeRecipient(),
    ]);

    if (!curve) {
      return { success: false, error: 'BondingCurve not found' };
    }
    if (curve.complete) {
      log.warn('Token migrated on Pump curve — attempting Jupiter exit', {
        reason,
        mint: mint.toBase58(),
      });
      return this.executeSellViaJupiter(position, reason);
    }

    const solOut    = calculateSolOut(curve, position.tokenAmount);
    const minSolOut = (solOut * (10_000n - BigInt(this.config.slippageBps))) / 10_000n;

    const tokenProgram             = await detectTokenProgram(this.connection, mint);
    const creatorVaultPda          = deriveCreatorVaultPda(curve.creator);
    const userVolumeAccumulatorPda = deriveUserVolumeAccumulatorPda(this.wallet.publicKey);
    const associatedBondingCurve   = getAssociatedTokenAddressSync(mint, bondingCurvePda, true, tokenProgram);
    const associatedUser           = getAssociatedTokenAddressSync(mint, this.wallet.publicKey, false, tokenProgram);

    log.info('Executing sell', {
      reason,
      mint: mint.toBase58(),
      tokenAmount: position.tokenAmount.toString(),
      expectedSol: (Number(solOut) / 1e9).toFixed(6),
    });

    const sellTx = await this.program.methods
      .sell(
        new BN(position.tokenAmount.toString()),
        new BN(minSolOut.toString()),
      )
      .accounts({
        global:                 this.globalPda,
        feeRecipient:           feeRecipient,
        mint:                   mint,
        bondingCurve:           bondingCurvePda,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser:         associatedUser,
        user:                   this.wallet.publicKey,
        systemProgram:          SystemProgram.programId,
        creatorVault:           creatorVaultPda,
        tokenProgram:           tokenProgram,
        eventAuthority:         this.eventAuthorityPda,
        program:                PUMP_PROGRAM_ID,
        feeConfig:              this.feeConfigPda,
        feeProgram:             FEE_PROGRAM_ID,
      })
      .transaction();

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.priorityFeeMicroLamports }),
      ...sellTx.instructions,
    );

    if (this.config.simulationMode) {
      const currentPrice = pricePerTokenLamports(curve);
      const pnlPct = ((Number(currentPrice) / Number(position.entryPricePerToken) - 1) * 100).toFixed(2);
      const simSig = `SIM_SELL_${crypto.randomBytes(16).toString('hex')}`;
      log.info('[SIMULATION] Sell would execute', {
        reason,
        mint: mint.toBase58(),
        tokenAmount: position.tokenAmount.toString(),
        expectedSol: (Number(solOut) / 1e9).toFixed(6),
        pnlPct: pnlPct + '%',
        simulatedSignature: simSig,
      });
      return { success: true, signature: simSig, expectedSolOutLamports: solOut };
    }

    const sendResult = await this.sendWithRetry(tx);
    return { ...sendResult, expectedSolOutLamports: solOut };
  }

  private async executeSellViaJupiter(position: Position, reason: ExitReason): Promise<ExecutionResult> {
    const log = getLogger();

    if (!this.config.enableMigrationExit) {
      return { success: false, error: 'Token migrated and ENABLE_MIGRATION_EXIT is false' };
    }

    const quote = await this.fetchJupiterQuote(position.mint, position.tokenAmount);
    if (!quote) {
      return { success: false, error: 'Failed to fetch Jupiter quote for migrated token exit' };
    }

    const expectedSolOutLamports = BigInt(quote.outAmount);

    if (this.config.simulationMode) {
      const simSig = `SIM_JUP_SELL_${crypto.randomBytes(16).toString('hex')}`;
      log.info('[SIMULATION] Jupiter sell would execute', {
        reason,
        mint: position.mint.toBase58(),
        tokenAmount: position.tokenAmount.toString(),
        expectedSol: (Number(expectedSolOutLamports) / 1e9).toFixed(6),
        simulatedSignature: simSig,
      });
      return { success: true, signature: simSig, expectedSolOutLamports };
    }

    const swapTxBase64 = await this.fetchJupiterSwapTransaction(quote);
    if (!swapTxBase64) {
      return { success: false, error: 'Failed to build Jupiter swap transaction' };
    }

    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
      tx.sign([this.wallet]);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await this.connection.confirmTransaction(signature, 'confirmed');

      log.info('Jupiter migrated-pool sell confirmed', {
        reason,
        mint: position.mint.toBase58(),
        signature,
      });

      return { success: true, signature, expectedSolOutLamports };
    } catch (err) {
      return {
        success: false,
        error: `Jupiter sell send failed: ${(err as Error).message}`,
      };
    }
  }

  private async fetchJupiterQuote(mint: PublicKey, tokenAmount: bigint): Promise<JupiterQuoteResponse | null> {
    const quoteUrl = new URL(this.config.jupiterQuoteUrl);
    quoteUrl.searchParams.set('inputMint', mint.toBase58());
    quoteUrl.searchParams.set('outputMint', JUPITER_SOL_MINT.toBase58());
    quoteUrl.searchParams.set('amount', tokenAmount.toString());
    quoteUrl.searchParams.set('swapMode', 'ExactIn');
    quoteUrl.searchParams.set('slippageBps', String(this.config.slippageBps));
    quoteUrl.searchParams.set('restrictIntermediateTokens', 'true');

    const json = await this.fetchJsonWithRetry(quoteUrl.toString(), { method: 'GET' });
    if (!json || typeof json !== 'object' || typeof (json as { outAmount?: unknown }).outAmount !== 'string') {
      return null;
    }

    return json as JupiterQuoteResponse;
  }

  private async fetchJupiterSwapTransaction(quote: JupiterQuoteResponse): Promise<string | null> {
    const payload = {
      quoteResponse: quote,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    };

    const json = await this.fetchJsonWithRetry(this.config.jupiterSwapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!json || typeof json !== 'object' || typeof (json as { swapTransaction?: unknown }).swapTransaction !== 'string') {
      return null;
    }
    return (json as JupiterSwapResponse).swapTransaction;
  }

  private async fetchJsonWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<unknown | null> {
    const log = getLogger();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
      } catch (err) {
        log.warn('HTTP request failed', {
          url,
          attempt,
          error: (err as Error).message,
        });
        if (attempt < maxAttempts) {
          await sleep(300 * attempt);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    return null;
  }

  private async getOrFetchFeeRecipient(): Promise<PublicKey> {
    const TTL_MS = 60 * 60 * 1000; // 1 hour
    if (this.feeRecipient && Date.now() - this.feeRecipientFetchedAt < TTL_MS) {
      return this.feeRecipient;
    }

    const global = await fetchGlobalState(this.connection, this.globalPda);
    if (!global) throw new Error('Failed to fetch Global state from chain');

    this.feeRecipient        = global.feeRecipient;
    this.feeRecipientFetchedAt = Date.now();
    return this.feeRecipient;
  }

  private async sendWithRetry(tx: Transaction, maxAttempts = 3): Promise<ExecutionResult> {
    const log = getLogger();
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          [this.wallet],
          { commitment: 'confirmed', skipPreflight: false },
        );
        return { success: true, signature };
      } catch (err) {
        lastError = (err as Error).message;
        log.warn('Send attempt failed', { attempt, error: lastError });
        if (attempt < maxAttempts) await sleep(500 * attempt);
      }
    }

    return { success: false, error: lastError };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
