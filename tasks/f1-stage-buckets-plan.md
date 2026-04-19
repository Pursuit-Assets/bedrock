# F1: Stage Bucket Sets + Intacct Kill Switch — Implementation Plan

**Status:** Drafted 2026-04-16. Revised after code-verification pass.
**Scope:** MVP philanthropy. Supersedes F1/F2/F3 sections of `tasks/stage-schema-drift.md` for MVP.
**PRs:** 2. One per concern.

All file paths and line numbers below verified against `2b34a4f` (current dev HEAD).

---

## 1. Context from 2026-04-16 investigation

SOQL against Pursuit's prod SF org (via Developer Console, run by JP) resolved the outstanding stage classifications:

| Stage | Count | Finding | F1 treatment |
|---|---:|---|---|
| `In Collection` | 650 | **ISA RecordType** (Pursuit Bond), 2019–2020 legacy. Out of philanthropy scope. | Excluded from all buckets |
| `Closed Won` | 575 | **Philanthropy RecordType**, all Donorbox auto-populated donations. `Campaign.Name = 'Online Donations'`; `Donorbox` appears in Opportunity.Name. `LeadSource` is null. CreatedDate range: 2019 → 2026-04-04 (actively flowing). | Included in `WON_STAGES` + `PAYMENT_RECEIVED_STAGES` |
| 7 remaining (~100 records) | PBC variants, `Close/Unknown`, `Contract Signing`, `Verbal Commitment`, `Closed / Sourcing` | Presumed PBC or dirty-data. Not queried this session. | Parked for future PBC/Bulk Edit sprint |

### JP directives captured during planning

- **SF stages are sacred.** No enum deprecation, no `LEGACY_STAGES` flag, no edit-UI hiding. Bucket on top.
- **F3 enum widen deferred.** MVP is philanthropy-only; widening waits for PBC + Bulk Edit sprint.
- **Pipeline Funnel stays granular.** Bucket sets are classifier plumbing; UI preserves per-stage detail.
- **Terminology:** `PAYMENT_RECEIVED_STAGES` (money in bank), not `REVENUE_RECEIVED_STAGES`.
- **F2 Intacct auto-invoicing stays off** until bundle ships: HITL gate + date guard + pre-flight cleanup + finance onboarding.
- **Donorbox nuance (future F2 bundle):** `Closed Won` donations are already-paid via Donorbox's Stripe processor. When F2 re-enables Intacct, its stage-based trigger MUST exclude Donorbox opps (filter on `Campaign.Name = 'Online Donations'` or `Name LIKE '%Donorbox%'`). They're receipts, not invoice-eligible.

---

## 2. Finalized bucket vocabulary

```
OPEN_STAGES              = {Lead Gen, New Lead, Qualifying,
                            Design / Proposal Creation, Proposal Negotiation,
                            Contract Creation, Negotiating Contract}
WON_STAGES               = {Collecting / In Effect, Closed / Completed, Closed Won}
LOST_STAGES              = {Closed Lost, Withdrawn, Closed / Did not Fulfill}
COLLECTING_STAGES        = {Collecting / In Effect}                    // ⊂ WON_STAGES
PAYMENT_RECEIVED_STAGES  = {Closed / Completed, Closed Won}            // ⊂ WON_STAGES
```

**Tested invariants:**
- `PAYMENT_RECEIVED_STAGES ⊂ WON_STAGES`
- `COLLECTING_STAGES ⊂ WON_STAGES`
- `PAYMENT_RECEIVED_STAGES ∩ COLLECTING_STAGES = ∅`
- `WON_STAGES ∩ LOST_STAGES = ∅`
- `WON_STAGES ∩ OPEN_STAGES = ∅`
- `LOST_STAGES ∩ OPEN_STAGES = ∅`

**Semantics:**
- `Collecting / In Effect` is in `WON_STAGES` because the Pursuit fundraising-team doc confirms it's 100% probability (contract signed, deal won). It's also in `COLLECTING_STAGES` (deal mid-collection — per JP: multi-year / multi-payment grants). It's NOT in `PAYMENT_RECEIVED_STAGES` because not all scheduled payments are in yet (partial payments live in SF Payment records + Sage).
- `Closed Won` is in `PAYMENT_RECEIVED_STAGES` because Donorbox deposits the money at the moment it writes the Opp — funds are received before the stage is set.

**Type approach (revised after verification):**
Only `WON_STAGES`, `LOST_STAGES`, and the new `PAYMENT_RECEIVED_STAGES` become `ReadonlySet<string>`. `OPEN_STAGES`, `COLLECTING_STAGES`, and `CLOSED_STAGES` stay as `readonly OpportunityStage[]` — all their members are in the 13-stage enum and multiple consumers (`useOpportunityData.ts:80,134,141,148`, `OpportunityEditDialog.tsx:62-65`, `salesforce.test.ts:52`) rely on array semantics (`.includes()`, spread). Widening them triggers a much larger refactor.

---

## 3. PR 1 — F1 bucket sets + funnel classifier fix

### 3.1 `financial_forecasting/frontend/src/types/salesforce.ts`

**Current state (verified):**
- L56–64: `OPEN_STAGES: readonly OpportunityStage[]` — 7 members
- L66–68: `COLLECTING_STAGES: readonly OpportunityStage[]` — 1 member
- L70–75: `CLOSED_STAGES: readonly OpportunityStage[]` — 4 members (includes `Closed / Completed`)
- L77–89: NOTE block about `data_sync.py` querying `'Closed Won'` as a mystery
- L90: `WON_STAGES: readonly OpportunityStage[] = ['Closed / Completed']`
- L92–96: `LOST_STAGES: readonly OpportunityStage[]` — 3 members

**Changes:**
- L77–89: Replace stale NOTE block with a shorter comment that references `tasks/f1-stage-buckets-plan.md` and states the MVP scope + Donorbox classification fact.
- L90: `export const WON_STAGES: ReadonlySet<string> = new Set(['Collecting / In Effect', 'Closed / Completed', 'Closed Won']);`
  - `Closed Won` is a string literal outside the `OpportunityStage` union — `ReadonlySet<string>` type admits it.
- L92–96: `export const LOST_STAGES: ReadonlySet<string> = new Set(['Closed Lost', 'Withdrawn', 'Closed / Did not Fulfill']);`
  - All members are in enum; still widen to `Set<string>` for symmetry with WON_STAGES and so future PBC-lost stages can land without a type change.
- Add new export `PAYMENT_RECEIVED_STAGES: ReadonlySet<string> = new Set(['Closed / Completed', 'Closed Won']);`
- L56–64, 66–68, 70–75: **unchanged** (OPEN / COLLECTING / CLOSED stay as `readonly OpportunityStage[]` — pre-existing consumer semantics preserved).

### 3.2 `financial_forecasting/models.py`

**Current state (verified):**
- L10–24: `OpportunityStage` enum — 13 values inheriting from `(str, Enum)`
- L28–36: `OPEN_STAGES: frozenset = frozenset({OpportunityStage.LEAD_GEN, ...})` — frozenset of enum members
- L38: `COLLECTING_STAGES: frozenset = frozenset({OpportunityStage.COLLECTING})`
- L40–45: `CLOSED_STAGES: frozenset` — 4 enum members (includes `CLOSED_COMPLETED`)

**Changes:**
Add new string-valued frozensets below the existing enum-valued ones. Use the `_SET` suffix to keep the pre-existing `OPEN_STAGES`/`COLLECTING_STAGES`/`CLOSED_STAGES` (which consumers import as enum-valued) intact:

```python
# String-valued bucket sets — admit stage values outside OpportunityStage enum
# (e.g., "Closed Won" for Donorbox legacy records).
# Mirrors the frontend buckets in frontend/src/types/salesforce.ts.
# See tasks/f1-stage-buckets-plan.md for context.
WON_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.COLLECTING.value,         # "Collecting / In Effect"
    OpportunityStage.CLOSED_COMPLETED.value,   # "Closed / Completed"
    "Closed Won",                              # Donorbox-auto-populated legacy (~575 records)
})

LOST_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.CLOSED_LOST.value,
    OpportunityStage.WITHDRAWN.value,
    OpportunityStage.CLOSED_DID_NOT_FULFILL.value,
})

COLLECTING_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.COLLECTING.value,
})

PAYMENT_RECEIVED_STAGES_SET: frozenset[str] = frozenset({
    OpportunityStage.CLOSED_COMPLETED.value,
    "Closed Won",
})
```

Reference-only for MVP. Becomes load-bearing when F2 bundle ships (consumed by `data_sync.py` SOQL query).

### 3.3 `financial_forecasting/frontend/src/components/pipelineFunnelTransitions.ts`

**Current state (verified):**
- L7–8: imports `WON_STAGES as CANONICAL_WON_STAGES`, `LOST_STAGES as CANONICAL_LOST_STAGES` from `../types/salesforce`
- L33: `export const WON_STAGES = new Set<string>(CANONICAL_WON_STAGES);`
- L34: `export const LOST_STAGES = new Set<string>(CANONICAL_LOST_STAGES);`
- L36–58: `classifyTransition` — uses `WON_STAGES.has()` / `LOST_STAGES.has()`

**Changes:**
- After F1 in 3.1, `types/salesforce.ts` already exports `WON_STAGES` / `LOST_STAGES` as `ReadonlySet<string>`. The `new Set<string>(...)` wrap at L33–34 becomes a redundant defensive copy.
- Two valid refactors:
  - **Option A (minimal):** Leave L33–34 as-is — `new Set<string>(existingSet)` still works (Set is iterable). Zero-line diff here beyond comment updates.
  - **Option B (cleaner):** Remove the wrap: `export { WON_STAGES, LOST_STAGES } from '../types/salesforce';` — single source of truth, no copy.
- **Go with Option A** for minimal blast radius in PR 1. Option B can be a follow-up.
- `classifyTransition` logic unchanged; behavior shifts automatically via the expanded source sets:
  - `classifyTransition(*, 'Closed Won')` → `'won'` (was `'backward'` with dev-console warning)
  - `classifyTransition(*, 'Collecting / In Effect')` → `'won'` (was `'forward'` — was in `ACTIVE_FUNNEL_STAGES`)
  - `classifyTransition(*, 'Closed / Completed')` → `'won'` (unchanged)

### 3.4 `financial_forecasting/frontend/src/types/salesforce.test.ts`

**Current state (verified):**
- L19–33: `BACKEND_STAGES` (13-stage hardcoded mirror)
- L40: 13-stage frontend↔backend parity assertion
- L43–45: `OPPORTUNITY_STAGES.toHaveLength(13)`
- L52: `const allGrouped = [...OPEN_STAGES, ...COLLECTING_STAGES, ...CLOSED_STAGES];`
- L54–56: "every non-None stage belongs to exactly one group"
- L59, 63, 67: individual group size assertions (OPEN=7, COLLECTING=1, CLOSED=4)

**Changes:**
- Keep existing 13-stage parity (unchanged — F3 deferred).
- Keep `allGrouped` completeness test (OPEN + COLLECTING + CLOSED still cover all 12 non-None enum stages).
- Add new describe block **"win/loss bucket memberships"**:
  - `WON_STAGES.has('Collecting / In Effect')` → true
  - `WON_STAGES.has('Closed / Completed')` → true
  - `WON_STAGES.has('Closed Won')` → true
  - `WON_STAGES.has('Closed Lost')` → false
  - `WON_STAGES.has('Withdrawn')` → false
  - `WON_STAGES.size` → 3
  - `LOST_STAGES.has('Closed Lost')` → true, `Withdrawn` → true, `Closed / Did not Fulfill` → true, `Closed / Completed` → false, size 3
  - `COLLECTING_STAGES.length` → 1 (readonly array, `.length` not `.size`)
  - `PAYMENT_RECEIVED_STAGES.has('Closed / Completed')` → true, `'Closed Won'` → true, `'Collecting / In Effect'` → false, size 2
- Add new describe block **"bucket invariants"**:
  - `PAYMENT_RECEIVED_STAGES` is subset of `WON_STAGES`
  - `COLLECTING_STAGES` (as strings) is subset of `WON_STAGES`
  - `PAYMENT_RECEIVED_STAGES ∩ COLLECTING_STAGES = ∅`
  - `WON_STAGES ∩ LOST_STAGES = ∅`
  - `WON_STAGES` has no overlap with `OPEN_STAGES`
  - `LOST_STAGES` has no overlap with `OPEN_STAGES`

### 3.5 `financial_forecasting/frontend/src/components/PipelineFunnel.test.ts`

**Current state (verified — file EXISTS at this path, not `pipelineFunnelTransitions.test.ts`):**
- L1: `import { classifyTransition, WON_STAGES, LOST_STAGES } from './pipelineFunnelTransitions';`
- L7–112: `describe('classifyTransition', ...)` covering wins, losses, forward, backward, terminal-state registry, and unknown-stage warnings
- L57: `it('treats Closed / Completed as the only win stage', ...)` — ← this description becomes wrong after F1
- L58–60: only-`Closed / Completed` WON assertion
- L63–67: LOST_STAGES membership assertions (no changes needed)
- L76–111: unknown-stages describe (behavior preserved — `Closed Won` and `Collecting / In Effect` become *known* after F1, so no warning; existing test at L103–106 already validates "no warn on known terminal" for Closed / Completed — extend to cover the two new members)

**Changes:**
- L57: rename description to `'treats Collecting, Closed / Completed, and Closed Won as win stages'`
- L58–60: expand WON_STAGES assertions to cover the new 3 members; keep the negative assertions
- Add wins-describe tests:
  - `classifyTransition('Qualifying', 'Closed Won') === 'won'`
  - `classifyTransition('Proposal Negotiation', 'Collecting / In Effect') === 'won'`
- Extend the "does not warn when target is a known terminal" block to verify no warn for `Closed Won` and `Collecting / In Effect` as target stages.
- Existing forward/backward tests within ACTIVE_FUNNEL_STAGES stay unchanged.

### 3.6 `financial_forecasting/tests/test_models_stage_buckets.py` (new)

Python-side parity with frontend:
- Assert membership of each of the 4 `_SET` frozensets
- Assert the 6 bucket invariants (subset + disjoint)
- Assert the frontend's hardcoded test values match the Python values — i.e. cross-language parity test (a second line of defense beyond the model enum parity that already lives in `salesforce.test.ts`).

### 3.7 Files NOT changed in PR 1 (deliberate)

- `Overview.tsx:76` — `CLOSED_WON_STAGES = ['Closed Won', 'Closed / Completed', 'Collecting / In Effect', 'Collecting', 'In Collection', 'In Effect']`. Defensive `.some(stage => opp.StageName?.includes(stage))` at L192, 254, 260, 279 is working correctly; leave as-is. Consumer refactor follow-up.
- `Overview.tsx:476` — `GOAL_STAGES = ['Collecting / In Effect', 'Closed / Completed']`. Does NOT include `Closed Won`. Donorbox donations don't count toward individual goals today — pre-existing behavior. **Follow-up decision needed with JP**: should Donorbox donations count toward individual fundraiser goals? If yes, update `GOAL_STAGES`; if no, leave.
- `GoalTracker.tsx:6` — same `GOAL_STAGES = ['Collecting / In Effect', 'Closed / Completed']`. Same question applies.
- `PaymentProcessing.tsx:93` — defensive `.includes('Closed Won')`. Keep.
- `Accounts.tsx:347, 620` — defensive `.includes('Closed Won')`. Keep.
- `Opportunities.tsx:208` — hardcoded `closedStages = ['Withdrawn', 'Closed Lost', 'Closed / Did not Fulfill', 'Closed / Completed']`. For "recently changed" UX on the Opportunities page. Does not include `Closed Won`. Pre-existing; consumer refactor follow-up.
- `Opportunities.tsx:211` — `newStage === 'Collecting / In Effect'` navigation trigger. Exact-string match for the payment-schedule redirect. Appropriate as-is.
- `OpportunityEditDialog.tsx:310` — `newStage === 'Closed / Completed'`. Exact-string match for the post-save callback. Appropriate as-is.
- `useOpportunityData.ts` — no changes (OPEN / COLLECTING / CLOSED unchanged).
- `forecasting_engine.py:179, 234, 538` — hardcoded stage literals in SOQL. Pre-existing bug (misses `Closed Won`): historical analysis skips Donorbox records; forecast treats Donorbox records as "open pipeline." **Known pre-existing defect; flagged for follow-up — NOT in PR 1.**
- `data_sync.py` — untouched in PR 1. PR 2 handles it.
- `OPPORTUNITY_STAGES` enum — stays at 13. No additions.

### 3.8 Risks & mitigations for PR 1

- **Funnel classifier behavior change is user-visible.** Historical `Closed Won` and `Collecting / In Effect` transitions flip from `backward`/`forward` to `won`. This IS the intended fix per the Pursuit fundraising-team doc's "100% probability = won" semantics. No feature flag (this is a correctness fix).
- **STAGE_COLORS at `types/salesforce.ts:29-43` is keyed by `OpportunityStage` (13 entries).** `Closed Won` isn't there; `getStageHexColor()` at L52–54 falls back to `'#9E9E9E'` (grey) for unknown stages. If any UI renders a `Closed Won` badge via `getStageHexColor`, it'll be grey. Acceptable for MVP — alternative is adding `Closed Won: '#1b5e20'` (same green as `Closed / Completed`) to STAGE_COLORS. Either choice is fine; I'll add the color mapping to match `Closed / Completed` since it's one extra line and makes Donorbox records visually consistent.

---

## 4. PR 2 — Intacct auto-invoice kill switch

### 4.1 `financial_forecasting/config.py`

**Current state (verified, 10 lines total):**
```python
"""Salesforce OAuth configuration — reads from environment variables."""

import os

SALESFORCE_CONFIG = {
    "CLIENT_ID": os.getenv("SALESFORCE_CLIENT_ID", ""),
    "CLIENT_SECRET": os.getenv("SALESFORCE_CLIENT_SECRET", ""),
    "DOMAIN": os.getenv("SALESFORCE_DOMAIN", "login"),
}
```

**Change:** Add module-level bool below `SALESFORCE_CONFIG`:

```python
# Intacct auto-invoicing — gated off by default until F2 bundle ships.
# When false, sync_opportunity_invoicing and handle_opportunity_stage_change
# short-circuit without writing to Intacct. Flip to true only after the
# F2 bundle is complete (expanded stage filter + Donorbox exclusion
# + date guard + HITL review + finance onboarding — see
# tasks/stage-schema-drift.md and tasks/f1-stage-buckets-plan.md).
INTACCT_AUTO_INVOICE_ENABLED: bool = (
    os.getenv("INTACCT_AUTO_INVOICE_ENABLED", "false").strip().lower() == "true"
)
```

Strict parse: only the literal string `"true"` (case-insensitive) enables. Any other value → false.

### 4.2 `financial_forecasting/config_example.py`

**Current state (verified):** comment-style doc of env vars.

**Change:** append a new paragraph:

```python
# Intacct auto-invoicing - set in env (default: false):
# INTACCT_AUTO_INVOICE_ENABLED  (true | false, default false)
# When false, sync_opportunity_invoicing and handle_opportunity_stage_change
# skip all Intacct writes. Stays off until the F2 bundle ships (expanded
# stage filter + Donorbox exclusion + date guard + HITL gate + finance
# onboarding). See tasks/stage-schema-drift.md.
```

### 4.3 `financial_forecasting/data_sync.py`

**Current state (verified):**
- L1–12: imports — no `config` import currently
- L17: class `DataSyncService`
- L27–29: `_intacct_available()` method
- L548: `async def sync_opportunity_invoicing(self):`
- L550: `if not self._intacct_available(): logger.debug(...); return`
- L565: `WHERE StageName = 'Closed Won'` in SOQL
- L590: `async def process_opportunity_for_invoicing(self, opportunity):` (NOT gated)
- L910: `async def handle_opportunity_stage_change(self, opportunity_id, new_stage, old_stage):`
- L916: `if new_stage == "Closed Won" and old_stage != "Closed Won":`

**Changes:**
- L12: add `import config` right after `from models import (...)`
  - Use `import config` (not `from config import INTACCT_AUTO_INVOICE_ENABLED`) so test monkey-patching via `monkeypatch.setattr(config, 'INTACCT_AUTO_INVOICE_ENABLED', True)` is effective. `from ... import X` captures the value at import time and is NOT monkey-patchable.
- `sync_opportunity_invoicing` (L548): insert a new guard above the `_intacct_available()` check:
  ```python
  async def sync_opportunity_invoicing(self):
      """Sync opportunities that are ready for invoicing."""
      if not config.INTACCT_AUTO_INVOICE_ENABLED:
          logger.info(
              "Skipping opportunity invoicing — INTACCT_AUTO_INVOICE_ENABLED=false "
              "(F2 bundle not yet shipped — see tasks/f1-stage-buckets-plan.md)"
          )
          return
      if not self._intacct_available():
          logger.debug("Skipping opportunity invoicing — Sage Intacct not connected")
          return
      ...
  ```
- `handle_opportunity_stage_change` (L910): insert the same guard at the top of the function (before the existing try block).
- Do NOT touch L565 (`WHERE StageName = 'Closed Won'`) or L916 (`if new_stage == "Closed Won" ...`). Those stay as-is — the guard prevents them from executing.
- `process_opportunity_for_invoicing` (L590): untouched. It's the per-opp processor, called BY `sync_opportunity_invoicing`. Not gated — the orchestrator gate prevents its invocation via the production flow. Tests that call it directly continue to exercise it.

### 4.4 `financial_forecasting/tests/test_data_sync_integration.py`

**Current state (verified):**
- 4 tests call a gated function directly:
  - L344 `test_sync_opportunity_invoicing_processes_ready_opps` → calls `sync_opportunity_invoicing()` at L370
  - L630 `test_individual_opp_failure_doesnt_stop_batch` → calls `sync_opportunity_invoicing()` at L662
  - L853 `test_closed_won_triggers_invoicing` → calls `handle_opportunity_stage_change(...)` at L873
  - L880 `test_non_closed_won_change_does_nothing` → calls `handle_opportunity_stage_change(...)` at L885
- Plus `TestFullSyncCycle.test_sync_all_data_calls_all_three_phases` (L42) — calls `sync_all_data` which internally calls `sync_opportunity_invoicing`.
- Many other tests call `process_opportunity_for_invoicing` directly (not gated) — they continue to work unchanged.

**Changes:**
- Add a module-level autouse fixture at the top of the file that sets `INTACCT_AUTO_INVOICE_ENABLED=True` for all tests in this file:
  ```python
  @pytest.fixture(autouse=True)
  def _enable_intacct_auto_invoice(monkeypatch):
      """These integration tests exercise the live Intacct invoice paths —
      flip the kill switch on for the file's duration. Production default is off."""
      import config
      monkeypatch.setattr(config, 'INTACCT_AUTO_INVOICE_ENABLED', True)
  ```
- Add a new test class at the bottom of the file for kill-switch behavior:
  ```python
  class TestIntacctAutoInvoiceKillSwitch:
      @pytest.mark.asyncio
      async def test_sync_opportunity_invoicing_noop_when_disabled(
          self, data_sync_service, mock_mcp_client, monkeypatch, caplog
      ):
          import config
          monkeypatch.setattr(config, 'INTACCT_AUTO_INVOICE_ENABLED', False)
          sf = mock_mcp_client.services["salesforce"]
          sf.query = AsyncMock()
          with caplog.at_level(logging.INFO):
              await data_sync_service.sync_opportunity_invoicing()
          sf.query.assert_not_called()
          assert any("INTACCT_AUTO_INVOICE_ENABLED=false" in m for m in caplog.messages)

      @pytest.mark.asyncio
      async def test_handle_opportunity_stage_change_noop_when_disabled(
          self, data_sync_service, mock_mcp_client, monkeypatch, caplog
      ):
          import config
          monkeypatch.setattr(config, 'INTACCT_AUTO_INVOICE_ENABLED', False)
          sf = mock_mcp_client.services["salesforce"]
          sf.get_record = AsyncMock()
          with caplog.at_level(logging.INFO):
              await data_sync_service.handle_opportunity_stage_change(
                  "006TEST", "Closed Won", "Contract Creation"
              )
          sf.get_record.assert_not_called()
          assert any("INTACCT_AUTO_INVOICE_ENABLED=false" in m for m in caplog.messages)
  ```
- The autouse fixture does not apply to `TestIntacctAutoInvoiceKillSwitch` class because each test in it re-patches to `False` AFTER the autouse patch to `True`. pytest's `monkeypatch` applies in order — the test-scoped call wins.

### 4.5 Risks & mitigations for PR 2

- **Active behavior change: 575 Closed Won records currently hit Intacct auto-invoice when Intacct is connected.** Kill switch stops this. Per JP's directive ("keep invoicing off until cleanup"), this is the intended effect. Also correct on its merits: Donorbox donations are already-paid receipts, not invoice-eligible.
- **Config parse is strict (`== "true"`).** Prevents accidental enable via typos (`"TRUE"`, `"1"`, `"yes"` all parse as false). Intentional.
- **Monkey-patch compatibility:** `import config` + `config.X` access at runtime. If a future contributor refactors to `from config import INTACCT_AUTO_INVOICE_ENABLED`, the monkeypatch breaks silently (tests pass unexpectedly). Mitigation: comment the pattern requirement at the import site.
- **Autouse fixture scope is file-only.** Other test files that exercise `data_sync.py` (if any) will see the default `False` and need their own override. Current audit: `test_data_sync_integration.py` is the only file that calls the two gated functions directly (confirmed via grep).

---

## 5. Drift-doc updates (part of PR 1)

Update `tasks/stage-schema-drift.md`:

### 5.1 Add section: "2026-04-16 investigation findings (resolved)"

- `In Collection` (650) — **ISA RecordType**, 2019–2020 legacy. Out of philanthropy scope.
- `Closed Won` (575) — **Philanthropy RecordType**, all Donorbox auto-populated donations. Identifier fingerprint: `Campaign.Name = 'Online Donations'` + `Donorbox` appears in `Opportunity.Name`. `LeadSource` null. CreatedDate 2019–2026-04-04 (actively flowing).
- Remaining 7 unclassified stages — parked for future PBC/Bulk Edit sprint.

### 5.2 Reframe F1 section

- Replace `LEGACY_STAGES` language with bucket vocabulary (per JP's "stages are sacred" feedback).
- Remove the "Leaning toward a LEGACY_STAGES label" sentence.
- Update F1 scope: frontend `types/salesforce.ts` bucket sets (`WON_STAGES`, `LOST_STAGES`, new `PAYMENT_RECEIVED_STAGES` widened to `ReadonlySet<string>`; `COLLECTING_STAGES`/`OPEN_STAGES`/`CLOSED_STAGES` stay as `readonly OpportunityStage[]`). Backend `models.py` canonical Python mirrors (`WON_STAGES_SET` etc. as `frozenset[str]`).

### 5.3 Reframe F2 section (now a bundle)

F2 is gated off by the PR 2 kill switch. When ready to flip, F2 scope expands to ALL of the following in a single bundled release:

1. **Expanded stage query** — `WHERE StageName IN (...)` built from `WON_STAGES_SET`, with SOQL interpolation using existing `escape_soql_string()` from `security.py:40` (precedent at `routes/finance.py:56`).
2. **Donorbox exclusion** — `AND NOT (Campaign.Name = 'Online Donations' OR Name LIKE '%Donorbox%')`. Critical: Donorbox donations are already-paid Stripe receipts, not invoice-eligible.
3. **RecordType filter** — `AND RecordType.Name = 'Philanthropy'` (or equivalent; exact string to be confirmed against SF picklist). Prevents ISA/PBC records from leaking into the Intacct flow.
4. **Date guard** — `AND CloseDate > '<flag-flip-date>'`. Historical backlog stays manual; only new deals flow through auto-invoice.
5. **Pre-flight data cleanup** — `Invoice_Status__c` backfilled on all pre-flag-flip `Closed / Completed` / `Collecting / In Effect` records that were invoiced outside Intacct. Delivered via future Bulk Edit page.
6. **HITL review queue** — auto-invoice proposals land in a pending-review state; finance approves before Intacct writes. Requires new DB table, UI, and workflow.
7. **Finance onboarding** — team confirms GL-mapping, monitors queue, knows how to approve/reject.

F2 deferred until ALL seven rails in place.

### 5.4 Reframe F3 section

- Deferred to post-MVP PBC + Bulk Edit sprint.
- When it ships: no LEGACY_STAGES flag; widen `OPPORTUNITY_STAGES` (and `OpportunityStage` enum) to full 22 stages without hiding any from editor UI.

### 5.5 Add section: "Known pre-existing defects exposed by F1 investigation (not fixed by F1/kill-switch)"

1. **`forecasting_engine.py:179, 234, 538`** — SOQL queries hardcode the terminal-closed stage list as `'Closed / Completed', 'Closed / Did not Fulfill', 'Closed Lost', 'Withdrawn'`. These do NOT include `Closed Won`. Effect:
   - L179 (historical analysis): 575 Donorbox records are excluded from the 2-year closed-opportunity history.
   - L234, L538 (open-pipeline forecasting): 575 Donorbox records are included as "open" (because they're `NOT IN` the hardcoded closed list), inflating open-pipeline counts and skewing payment forecasts.
   - **Recommended fix:** follow-up PR that replaces the hardcoded literals with `WON_STAGES_SET ∪ LOST_STAGES_SET` references.
2. **RecordType filtering audit.** Frontend opportunity fetchers other than `useOpportunityData.ts` may not pass `record_type='Philanthropy'`. E.g., the Overview page, Progress page, and Accounts page fetchers. Any that don't filter are showing ISA + PBC records mixed in with philanthropy views. Inventory + systematic filter addition is a separate PR.
3. **`main.py:342–345` stage param validation** — `if s in VALID_STAGES` filters incoming stage filters against the 13-stage enum. If a frontend caller passes `stages=['Closed Won']`, it's silently dropped. Currently not a blocker (no frontend caller does this). Document.
4. **Consumer stage-list drift.** Multiple frontend files have their own hardcoded stage arrays that are equivalent to but desynced from `types/salesforce.ts` buckets:
   - `Overview.tsx:76` CLOSED_WON_STAGES (6-entry defensive substring list — actively correct; keep)
   - `Overview.tsx:476` GOAL_STAGES (2 entries; no Closed Won — excludes Donorbox from goals)
   - `GoalTracker.tsx:6` GOAL_STAGES (same 2 entries)
   - `Opportunities.tsx:208` closedStages (4 entries; no Closed Won)
   - Follow-up PR: normalize these to import from `types/salesforce.ts`.
5. **Donorbox goal-inclusion decision.** Should Donorbox donations count toward individual fundraiser goals? `GOAL_STAGES` currently excludes them. **Needs JP's call.** Product decision, not technical.

---

## 6. Sequencing & rollout

- **PR 1** — F1 bucket sets + funnel classifier fix + drift-doc reframe. Low-risk correctness fix. Squash-merge to `dev`.
- **PR 2** — Intacct auto-invoice kill switch. Can ship in parallel (no code dependency on PR 1). Squash-merge to `dev`.
- No prod migration required for either PR.
- No dev→main promotion tied to these PRs (batching continues per existing plan).
- When F2 bundle eventually ships: prod `.env` gets `INTACCT_AUTO_INVOICE_ENABLED=true` as the flip-the-switch moment.

---

## 7. Explicit non-goals

| Non-goal | Why excluded |
|---|---|
| F3 enum widen | MVP is philanthropy-only; deferred to PBC/Bulk Edit sprint |
| `LEGACY_STAGES` flag / UI hiding | SF stages are sacred per JP |
| Consumer refactor of defensive `.includes('Closed Won')` | Keeps PR 1 diff tight |
| `forecasting_engine.py` stage-literal fix | Pre-existing defect; separate PR |
| Frontend consumer-array normalization (Overview GOAL_STAGES, Opportunities.tsx:208, etc.) | Separate PR |
| `Closed Won` added to `STAGE_COLORS` as a *new* color | Included as same-green-as-Closed-Completed, trivial one-line addition |
| Expanded Intacct stage filter | Deferred to F2 bundle |
| RecordType filtering audit on philanthropy queries | Separate tech-debt item; documented |
| Fundraising glossary for remaining 7 stages | Not needed for philanthropy MVP |
| Donorbox goal-inclusion decision | Product question for JP; flagged above |

---

## 8. Success criteria

- All new + existing frontend tests pass (both `salesforce.test.ts` and `PipelineFunnel.test.ts`).
- New `test_models_stage_buckets.py` passes; cross-language parity assertion passes.
- Existing frontend parity test still asserts 13-stage enum match (F3 scope unchanged).
- `classifyTransition` produces correct `won`/`lost` for all 6 terminal stages: Collecting / In Effect, Closed / Completed, Closed Won, Closed Lost, Withdrawn, Closed / Did not Fulfill.
- `test_data_sync_integration.py` all tests pass (autouse fixture keeps existing behavior; new `TestIntacctAutoInvoiceKillSwitch` validates disabled-path).
- `data_sync.py` gated functions log the skip message and no-op with flag=false (default).
- Drift doc reflects 2026-04-16 findings + reframed F1/F2/F3 scope + known pre-existing defects.
