import { PublicKey } from '@solana/web3.js';

export type ExitReason = 'take-profit' | 'stop-loss' | 'manual' | 'mirror';

/** Raw data decoded from a detected pump.fun buy instruction on the target wallet */
export interface DetectedBuy {
  kind: 'buy';
  /** Transaction signature where the buy was detected */
  signature: string;
  /** Token mint address */
  mint: PublicKey;
  /** Target wallet that performed the buy */
  buyer: PublicKey;
  /** Token amount bought (raw, no decimals applied) */
  tokenAmount: bigint;
  /** Max SOL cost paid (lamports) */
  maxSolCost: bigint;
  /** Bonding curve PDA for this mint */
  bondingCurve: PublicKey;
  /** Timestamp of detection (ms) */
  detectedAt: number;
}

/** Raw data decoded from a detected pump.fun sell instruction on the target wallet */
export interface DetectedSell {
  kind: 'sell';
  signature: string;
  mint: PublicKey;
  seller: PublicKey;
  tokenAmount: bigint;
  minSolOutput: bigint;
  bondingCurve: PublicKey;
  detectedAt: number;
}

export type DetectedSignal = DetectedBuy | DetectedSell;

/** Deserialized bonding curve account data */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
}

/** Deserialized global state account data */
export interface GlobalState {
  initialized: boolean;
  authority: PublicKey;
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
}

/** An open position we hold */
export interface Position {
  mint: PublicKey;
  tokenAmount: bigint;
  /** SOL spent to enter (lamports) */
  entryLamports: bigint;
  /** Entry price: fixed-point lamports per token (scaled, integer) */
  entryPricePerToken: bigint;
  enteredAt: number;
  takeProfitPrice: bigint;
  stopLossPrice: bigint;
}

/** Result of a buy or sell execution */
export interface ExecutionResult {
  success: boolean;
  signature?: string;
  error?: string;
  expectedSolOutLamports?: bigint;
}

/** Summary of a closed trade for terminal reporting */
export interface ClosedTrade {
  mint: string;
  reason: ExitReason;
  tokenAmount: bigint;
  entryLamports: bigint;
  exitLamports: bigint;
  pnlLamports: bigint;
  pnlPct: number;
  signature?: string;
  closedAt: number;
}
