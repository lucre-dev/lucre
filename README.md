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
pnpm install && pnpm build && pnpm test

# put `lucre` on your PATH
pnpm link-cli
# or: alias lucre='node /path/to/lucre/apps/agent/dist/index.js'

lucre                  # interactive CLI (Bedrock agent + tools)
```

### Interactive CLI (the main product)

```
lucre                 # first run → setup; later → desk
lucre --desk          # skip setup gate
```

**First run (one time, ledger state):** no GENESIS / no mandate → onboarding → type `RATIFY` → desk.  
**Ready:** `lucre` opens the desk directly.

```
› /status
› /balance
› /profit
› /usage
› /quit
```

Core slash: `/status` `/balance` `/profit` `/positions` `/trades` `/usage` `/model` `/help` `/quit`.  
Decide: chat or `lucre decide [--execute]` (Bedrock Sonnet).  
Schedule: `lucre install-agent`.

### Headless

```sh
pnpm lucre init
pnpm lucre sync
pnpm lucre mandate seed-demo
pnpm lucre run                 # stub decision cycle
pnpm lucre verify
```

Ledger: `~/.lucre/events.jsonl` · keys: `~/.tokens` (`ALPACA_*`, `AWS_BEARER_TOKEN_BEDROCK`).

## Status

- **M0–M2** — ledger, Alpaca, stub executor
- **M3** — decision brains (OpenAI + Bedrock path)
- **TUI** — `lucre` interactive agent CLI (slash + tools + bash)
