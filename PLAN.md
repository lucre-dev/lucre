# lucre — build plan

Personal autonomous trading agent. Ledger-first spine (compt DNA), Alpaca paper execution, GPT-5.6 Terra daily brain, Lynch mandate.

## Architecture

```
lucre/
  packages/types    zod schemas: events, mandate, decision, risk, money, ids
  packages/core     PURE: reducer, state, selectors, legalMoves, hash — no I/O, no Date.now()
  apps/agent        all I/O: jsonl store, alpaca, brains, pipelines, cli   (M1+)
```

Storage (M1): `~/.lucre/events.jsonl` — append + fsync + flock + hash chain. No SQLite, no network DB.

## Model stack (cost ~$6–10/mo)

| Role | Model | Notes |
|------|-------|-------|
| Daily decision | GPT-5.6 Terra (batch) | structured `json_schema`, overnight |
| Screens | gpt-5.4-mini, trigger-gated | $0 when no trigger |
| Weekly review | GPT-5.6 Sol (batch) | deeper judgment |
| Spend cap | $10/mo hard | halts analysis, never stop-loss job |

Scheduler: Mac `launchd` + `pmset` wake (no droplet until flaky).

## Daily loop (ET)

1. **~07:00** orphan sweep + reconcile (blocking)
2. **~07:30** decision submit (Batch API) — legal-moves menu precomputed
3. **~09:15** harvest; malformed → WAIT
4. **~09:28** re-quote & clamp; market orders unrepresentable
5. **09:30+** execute — `ORDER_SUBMITTED` fsynced *before* HTTP POST
6. Intraday: deterministic stop-loss only; screens sell-only
7. **~16:05** equity mark + memory note

## Milestones

### M0 — spine ✅
`packages/types` + `packages/core`: reducer, selectors, `computeLegalMoves`, hash chain.
**Done when:** property tests pass — chain breaks throw; replay is deterministic; legal moves cannot invent off-mandate BUYs.

### M1 — broker + ledger I/O ✅
Alpaca client, JSONL store (`~/.lucre/events.jsonl`), reconcile, orphan sweep.
**Done when:** `lucre init && lucre sync && lucre verify` clean against paper account.

### M2 — unattended loop, stub brain (partial ✅)
Stub brain + `lucre run`, executor with SimBroker chaos tests (no duplicate client orders), mandate seed-demo.
Still open: scheduled launchd timers, full 120-day replay harness, corp-action API sync job.
**Done when:** zero unexplained drift, zero duplicate orders across replays.

### M3 — real brain (partial ✅)
OpenAI brain with strict json_schema → Decision; `INFERENCE_RECORDED` + monthly cap; `lucre run --brain openai|terra`.
Still open: Batch API overnight path, Haiku/mini screens, memory files, 5-day paper streak.
**Done when:** 5 consecutive live paper days with decisions in budget.

### M4 — soak
6–8 weeks armed paper; weekly Sol reviews; alert drills.
**Done when:** live gate criteria met.

## Live gate (`lucre gate`)

≥30 clean paper sessions; zero unexplained reconciliation divergence; zero hash-chain breaks; zero untraceable orders; cost <10% of paper edge. Start live with small capital + position caps; auto-revert to paper on gate violation.

## Invariants

1. Daily cadence only (no intraday decision loops)
2. Pre-validated action space — model picks move **by id**
3. Hard monthly spend cap
4. Append-only ledger — fix by appending
5. Paper until proven
6. Limit orders only (market orders not in the type system)
7. Mandate-enforced universe (Lynch + exclusions fail-closed)
