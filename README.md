# lucre

Personal autonomous trading agent. Private — not a product.

Give it money, it trades. Daily cadence, disciplined, paper-first.

## What it does

- One deep decision run per trading day (pre-market): Sonnet-class model reviews positions, news digest, and its own past run notes, then emits a structured decision — `WAIT` / `BUY at price` / `SELL at price` — with sizing and reasoning.
- Cheap intraday screens (Haiku-class) watch for price/news triggers and escalate to an extra deep run only when warranted.
- Executes against **Alpaca** (paper account first; live only after a proven paper run).
- Every decision, order, and fill is appended to a hash-chained event ledger (compt-style). Cost ledger sits next to the P&L ledger — every run logs tokens and dollars, so inference cost as % of profit is always visible.

## Invariants

1. **Daily cadence.** No intraday trading loops. Screens may watch; only the deep run may trade.
2. **Pre-validated action space.** Cash, position limits, and max order size are computed deterministically *before* the model chooses. The model picks from legal moves; it cannot invent one.
3. **Hard monthly spend cap.** If API spend exceeds the cap, the agent halts new analysis (never positions).
4. **Append-only ledger.** State is derived from events, never stored. Fixing anything = appending a correcting event.
5. **Paper until proven.** Live keys stay out of the environment until the paper track record earns them.

## Setup

Keys live in `~/.tokens` (never in this repo):

- `ALPACA_PAPER_KEY_ID` / `ALPACA_PAPER_SECRET_KEY` — paper endpoint `https://paper-api.alpaca.markets/v2`
- `ANTHROPIC_API_KEY` — inference

```sh
pnpm install
pnpm test
```

## Costs

Target all-in: ~$8–12/month (daily Sonnet decision via Batch API, Haiku screens, weekly Opus portfolio review, prompt-cached playbook prefix). Alpaca: $0 commissions, free IEX data.
