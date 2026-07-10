# lucre

Personal autonomous trading agent. Private — not a product.

Give it money, it trades. Daily cadence, disciplined, paper-first.

Tagline energy: **install a hedge fund.**

## What it does

- One deep decision run per trading day (pre-market): GPT-5.6 Terra reviews positions, news digest, and its own past run notes, then emits a structured decision — `WAIT` / `BUY` / `SELL` — picking **by id from a precomputed legal-moves menu**.
- Cheap screens (gpt-5.4-mini) fire only on code-computed triggers; sell-only escalations.
- Executes against **Alpaca** (paper first). Limit orders only — market orders are not in the type system.
- Lynch mandate: invest in what you know. Onboarding interview → event-sourced mandate with ethical exclusions (fail-closed).
- Every decision, order, and fill is appended to a hash-chained event ledger. Cost ledger sits next to P&L.

## Invariants

1. **Daily cadence.** No intraday trading loops.
2. **Pre-validated action space.** The model cannot invent a ticker, size, or side.
3. **Hard monthly spend cap** ($10). Halts analysis, never the stop-loss job.
4. **Append-only ledger.** Fix by appending; never mutate history.
5. **Paper until proven.**

## Layout

```
packages/types   zod schemas (events, mandate, decision, risk)
packages/core    pure reducer, selectors, legalMoves, hash
apps/agent       CLI + Alpaca + brains (M1+)
```

See `PLAN.md` for milestones. See `MANDATE.md` for the onboarding/enforcement spec.

## Setup

Keys live in `~/.tokens` (never in this repo):

- `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY` — paper endpoint `https://paper-api.alpaca.markets/v2`
- `OPENAI_API_KEY` — decision/screen inference

```sh
pnpm install
pnpm build
pnpm test

# CLI (keys from ~/.tokens)
pnpm lucre init
pnpm lucre sync
pnpm lucre mandate seed-demo   # or: mandate import universe.json
pnpm lucre run                 # stub brain → WAIT / menu
pnpm lucre run --allow-buy --execute   # stub may place a 1-share test buy
pnpm lucre verify
pnpm lucre status
```

Ledger: `~/.lucre/events.jsonl` (override with `LUCRE_HOME`).

## Costs

Target all-in: **~$6–10/month** (Terra batch daily decision, mini screens, Sol weekly review). Alpaca: $0 commissions, free IEX data. Scheduler: local `launchd` (no droplet).

## Status

- **M0** — types + pure core (reducer, hash chain, legal moves)
- **M1** — JSONL store, Alpaca client, `init` / `sync` / `verify` / `status`
- **M2 (in progress)** — stub brain, executor (`ORDER_SUBMITTED` before POST), SimBroker chaos tests, `lucre run`
