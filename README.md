# Pump.fun Copy Trade Bot

TypeScript Solana bot that watches a target wallet for Pump.fun buys, mirrors entries, and manages exits with mirror-exit, stop-loss, take-profit, and migrated-token fallback support.

## Features

- Watches one target wallet over WebSocket `logsSubscribe`
- Decodes Pump.fun buy and sell instructions from transactions
- Mirrors buys through the Pump.fun program
- Supports mirror exits when the target wallet sells
- Supports stop-loss and take-profit checks for open positions
- Falls back to Jupiter swaps for migrated tokens when enabled
- Includes simulation mode so you can test without sending real trades

## Requirements

- Node.js 20+ recommended
- npm
- Solana wallet private key for live trading
- Helius RPC HTTP and WebSocket endpoints

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your values, then run:

```bash
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `SIMULATION_MODE` | No | `true` avoids real transactions. Defaults to safe testing when set in `.env.example`. |
| `MIRROR_EXIT` | No | When `true`, exits on detected target-wallet sells. Take-profit is ignored in this mode. |
| `HELIUS_API_KEY` | No | Optional helper value for building your RPC URLs. |
| `RPC_HTTP` | Yes | Solana JSON-RPC HTTP endpoint. |
| `RPC_WSS` | Yes | Solana WebSocket endpoint for log subscriptions. |
| `ENABLE_MIGRATION_EXIT` | No | Enables Jupiter exit flow after a Pump.fun token migrates. |
| `JUPITER_QUOTE_URL` | No | Jupiter quote endpoint. |
| `JUPITER_SWAP_URL` | No | Jupiter swap endpoint. |
| `PRIVATE_KEY` | Live mode only | Base58-encoded Solana secret key. Optional in simulation mode. |
| `TARGET_WALLET` | Yes | Wallet address to follow. |
| `BUY_AMOUNT_SOL` | No | SOL amount to spend per mirrored buy. |
| `SLIPPAGE_BPS` | No | Slippage in basis points. |
| `PRIORITY_FEE_MICROLAMPORTS` | No | Priority fee for transactions. |
| `STOP_LOSS_PCT` | No | Exit threshold below entry price. |
| `TAKE_PROFIT_PCT` | No | Profit-taking threshold. Ignored when `MIRROR_EXIT=true`. |
| `EXIT_POLL_INTERVAL_MS` | No | Poll interval for open-position exit checks. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, or `error`. |

## Scripts

- `npm run dev` runs the bot from TypeScript with `tsx`
- `npm run build` compiles to `dist/`
- `npm run typecheck` runs TypeScript checks without emitting output
- `npm start` runs the compiled build

## Safety Notes

- Start with `SIMULATION_MODE=true`.
- Keep `.env` private. It is ignored by Git in this repo.
- This project sends real Solana transactions when simulation mode is off.
- Copy trading is risky. Review the code and test with small amounts before live usage.
