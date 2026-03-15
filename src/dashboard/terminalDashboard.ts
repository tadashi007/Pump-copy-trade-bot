import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ClosedTrade } from '../types.js';

const MAX_ROWS = 8;

export class TerminalDashboard {
  private readonly closedTrades: ClosedTrade[] = [];

  constructor(
    private readonly startingBalanceLamports: bigint,
    private readonly wallet: string,
    private readonly simulationMode: boolean,
  ) {
    this.render();
  }

  addClosedTrade(trade: ClosedTrade): void {
    this.closedTrades.push(trade);
    this.render();
  }

  private render(): void {
    const realizedPnlLamports = this.closedTrades.reduce((sum, t) => sum + t.pnlLamports, 0n);
    const realizedPnlPct = this.startingBalanceLamports > 0n
      ? Number((realizedPnlLamports * 10_000n) / this.startingBalanceLamports) / 100
      : 0;

    const rows = this.closedTrades.slice(-MAX_ROWS);
    const lines: string[] = [];

    lines.push('+- Terminal PnL ---------------------------------------------------------------+');
    lines.push(
      `| Wallet: ${truncate(this.wallet, 18).padEnd(18)}  Start: ${formatSol(this.startingBalanceLamports).padStart(10)}  Realized: ${formatSignedSol(realizedPnlLamports).padStart(11)} (${formatSignedPct(realizedPnlPct).padStart(8)}) |`,
    );
    lines.push(`| Mode: ${this.simulationMode ? 'SIMULATION' : 'LIVE'}  Closed Trades: ${String(this.closedTrades.length).padStart(3)}${' '.repeat(46)}|`);
    lines.push('+----+----------------+------------+------------+------------+---------+------------+');
    lines.push('| #  | Mint           | Entry SOL  | Exit SOL   | PnL SOL    | PnL %   | Reason     |');
    lines.push('+----+----------------+------------+------------+------------+---------+------------+');

    if (rows.length === 0) {
      lines.push('| -- | (no closed trades yet)                                                   |');
    } else {
      rows.forEach((t, idx) => {
        lines.push([
          '| ',
          String(this.closedTrades.length - rows.length + idx + 1).padStart(2), ' ',
          '| ', truncate(t.mint, 14).padEnd(14), ' ',
          '| ', formatSol(t.entryLamports).padStart(10), ' ',
          '| ', formatSol(t.exitLamports).padStart(10), ' ',
          '| ', formatSignedSol(t.pnlLamports).padStart(10), ' ',
          '| ', formatSignedPct(t.pnlPct).padStart(7), ' ',
          '| ', t.reason.padEnd(10), ' ',
          '|',
        ].join(''));
      });
    }

    lines.push('+----+----------------+------------+------------+------------+---------+------------+');
    process.stdout.write(`\n${lines.join('\n')}\n`);
  }
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, width - 3)}...`;
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

function formatSignedSol(lamports: bigint): string {
  const sign = lamports >= 0n ? '+' : '-';
  const abs = lamports >= 0n ? lamports : -lamports;
  return `${sign}${formatSol(abs)}`;
}

function formatSignedPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '-';
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}
