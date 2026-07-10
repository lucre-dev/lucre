# Mandate — onboarding interview & enforcement spec

The mandate is the owner's investing constitution: universe (Lynch "invest in what you know"),
ethical exclusions, sector tilt, strategy preferences, risk tolerance. It is **event-sourced,
never a config file** — `lucre init` produces `MANDATE_SET` v1; every later change appends
`MANDATE_CHANGED`. The daily pipeline derives the effective mandate from the ledger and computes
the legal-moves menu from it. The model picks a move **by id from the menu** — it is structurally
incapable of proposing a ticker, size, or side outside the mandate.

## 1. Onboarding interview (`lucre init`)

Conversational LLM session in the terminal, ~20–30 min, six phases. Each phase is a node in a
deterministic state machine: the LLM converses freely but can only exit a node via a structured
tool call that must pass zod. Chat is the UX; typed extractions are the record. Draft checkpoints
to `~/.lucre/interview.draft.json` (encrypted at rest, resumable via `lucre init --resume`);
**nothing touches the ledger until the owner types RATIFY.**

1. **Universe (Lynch capture, ~10 min).** "Walk me through yesterday, waking to sleeping — what
   did you actually touch? Name products, not tickers." Then: monthly subscriptions (strongest
   signal), recent adoptions, recent churns. For every product:
   - **Payment probe:** "Do you pay for this out of pocket, or is it bundled/free?" →
     `paymentRelation: paid_direct | bundled | free_tier | ad_supported`. Bundled/free can enter
     the universe but cannot earn top conviction without an explicit override (the
     Netflix-via-T-Mobile problem).
   - **Ticker mapping:** LLM proposes company → ticker; deterministically verified against
     Alpaca `/v2/assets` (active, tradable, exchange-listed). Identity is keyed on
     **`alpacaAssetId` + issuer name — ticker is display-only** (FB→META renames, recycled
     symbols, ZM vs ZOOM shell). Confirm prompt always shows legal name + exchange.
   - **No ETFs/funds.** Single-name common stock only — "SPY is a basket; I can't screen 500
     companies for your exclusions." Funds nullify both the Lynch doctrine and the screens.
   - Private/unbuyable (OpenAI, Notion) → watchlist with IPO-watch flag; structurally excluded
     from legal moves.
   - **Conviction calibration:** after 1–5 ratings, a forced cut — "if you could only keep 3,
     which?" — because everything gets rated 5 in a fun chat. The ranking is stored and gates
     default sizing.
2. **Exclusions (~5 min).** "Any businesses you won't own on principle? Common screens: alcohol,
   pork, gambling, tobacco, weapons, adult content, interest-based lending — or custom." Then the
   threshold question asked with a live case from *his own universe*: "Costco sells alcohol,
   ~4–5% of revenue. Where's your line? (a) zero tolerance (b) incidental <5% ok (halal-screen
   convention) (c) core-business test." Per-category overrides allowed (`pork: hard@0`,
   `alcohol: soft@5`). Custom categories carry an owner-written definition fed verbatim to the
   screening prompt. `interest_finance` is scoped to *lending as an operating segment*, not
   treasury income (else Apple is haram and the universe is empty).
3. **Tilt (~2 min).** Sector stances (overweight/neutral/zero) + tolerance band. Tech-heavy is a
   feature, not a bug — reported honestly in the weekly review, never silently "fixed."
4. **Strategy (~3 min).** Enable + rank doctrines: buy-and-hold growth, swing momentum,
   buy-the-dip (with trigger %), catalyst/earnings plays. Capital weight per enabled doctrine.
5. **Risk (~5 min).** Elicited via fixed behavioral scenarios, never self-ratings: "account is
   down 30% in a month — what should the agent have already done?", "one position is down 50%",
   "a winner is now 40% of the portfolio — trim or let it ride?", "what's the 2am number, in
   dollars?" A fixed rubric derives `maxPositionPct`, `maxSectorPct`, `cashFloorPct`,
   `drawdownHaltPct`, `aggressiveness` — shown back for confirmation.
6. **Ratify.** Owner sees the compiled mandate **plus a dry-run of tomorrow's actual legal-moves
   menu** — ratifying observed behavior, not abstract settings. Any existing Alpaca positions get
   a forced per-name ruling first (adopt / sell / grandfather). Typing `RATIFY` appends
   `MANDATE_SET` + `INTERVIEW_ARCHIVED` (transcript hash only in-ledger; verbatim transcript
   encrypted locally — it contains a card statement).

## 2. Schema (packages/types/src/mandate.ts — abbreviated)

```ts
UniverseEntry {
  assetId, cik?, ticker /* display-only */, companyName, exchange,
  productsUsed[], usageEvidence /* owner verbatim */,
  paymentRelation: 'paid_direct'|'bundled'|'free_tier'|'ad_supported',
  conviction: 1..5, forcedRank?: number,
  status: 'tradable'|'private'|'unmapped'|'flagged'|'add_frozen',
  addedAt, lastAffirmedAt /* ISO dates — staleness needs timestamps */,
}
ExclusionRule {
  id, category: enum|'custom', customLabel?, ownerDefinition?,
  mode: 'hard'|'soft', revenueThresholdPct, notes,
}
Adjudication {           // the "Costco file" — edge-case rulings with a lifecycle
  assetId, category, ruling: 'keep'|'exclude'|'exception',
  exposureEstimatePct, thresholdAtRuling, dataAsOf, ownerQuote,
  reopenOn: { thresholdChange: true, estimateMovePp: 2, afterMonths: 12 },
}
Tilt { tilts: [{sector, stance, targetPct?}], tolerancePct }
StrategyPrefs { enabled flags + ranking + dipTriggerPct? + earningsBlackoutDays + capital weights }
RiskParams { aggressiveness, maxPositionPct, maxSectorPct, cashFloorPct,
             drawdownHaltPct, maxSingleOrderPct, minHoldDays, maxTradesPerWeek }
Mandate { version, schemaVersion, entries[], watchlist[], exclusions[],
          adjudications[], tilt, strategy, risk, interviewTranscriptHash }
```

## 3. Ledger events added

- `MANDATE_SET` — ratified v1 (full document + `mandateHash` over stored bytes, never a re-parse)
- `MANDATE_CHANGED` — full snapshot + structured diff + `basedOnVersion` (**optimistic
  concurrency: reducer rejects if `basedOnVersion !== state.mandateVersion`** — an edit session
  must rebase over flags appended mid-session). Risk-*loosening* edits carry a 72h `effectiveAt`
  cooling-off; tightening is immediate.
- `INTERVIEW_ARCHIVED`, `UNIVERSE_TICKER_FLAGGED`, `UNIVERSE_FLAG_RESOLVED`,
  `MANDATE_DRIFT_FLAGGED`, `MANDATE_ADJUDICATED`, `POSITION_CONVERTED` (mergers/spinoffs)
- Every `DECISION_MADE` / `LEGAL_MOVES_COMPUTED` is stamped with `mandateVersion + mandateHash +
  algoVersion` — historical events are judged against the version that governed them; a bugfix to
  `computeLegalMoves` never invalidates old chains. Event payloads carry `schemaVersion` and are
  parsed with their version-matched schema on replay.

## 4. Enforcement (where the mandate bites)

- **Menu computation:** `computeLegalMoves(mandate, portfolio, snapshot)` — pure. BUY candidates
  = universe ∩ tradable ∩ not-excluded ∩ not-flagged ∩ risk-sized (position/sector/cash-floor
  caps shrink or delete moves). Screens **gate BUY only, never SELL**: every held lot always has
  a legal SELL (exclusion-driven exits get an explicit minHoldDays override lane).
- **Hard exclusions fail closed** on categorical involvement flags ("does this issuer produce/
  sell X at all"), not revenue estimates; a name with missing exposure data for any active
  category is unbuyable until adjudicated. Soft exclusions use thresholds + adjudications.
- **Exclusion added while held** forces an adjudication in the same edit session:
  divest-now / divest-by-date / grandfather-hold-no-add. Same-day tightening **voids any standing
  computed menu** — no 4pm buy off a menu computed before a noon exclusion.
- **Screens watchlist = universe only.** Inherited positions from corporate actions (merger
  stock, spinoffs) are auto-flagged; their SELL is always legal.
- **Weekly review (drift):** exposure re-screen from filings (fail-closed on FPIs/ADRs without
  parseable filings), acquisition *announcements* (revenue data lags a year), tilt drift beyond
  tolerance, concentration report, adjudication reopen triggers.
- **Quarterly re-affirmation:** "still paying for these? anything new on the card statement?"
  Entries unaffirmed 2 cycles → `add_frozen` (hold/sell only, never auto-removed). The universe
  must not outlive the owner's actual usage.

## 5. CLI surface

```
lucre init                 # the interview (resumable)
lucre mandate show         # effective mandate @ current version, human-readable
lucre mandate edit         # conversational amendment → MANDATE_CHANGED
lucre mandate affirm       # quarterly usage re-affirmation
lucre mandate history      # version log with diffs
```
