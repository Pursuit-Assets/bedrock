# Frontend stage-list drift — consolidation plan

**Status:** DEFERRED. Parked by JP 2026-04-17 during the F1 / test-fixture session ("let's do Candidate 3 thoroughly in a new shell"). This doc captures the four-pass verification research from that session so a future session can pick it up cold.

**Relationship to other docs:**
- Originates from `tasks/stage-schema-drift.md` § "Known pre-existing defects" item 4.
- Complements `tasks/recordtype-audit-post-mvp.md` — several drift sites below are contamination artifacts that will dissolve once the RecordType audit ships (ISA records will never enter the dataset to begin with).
- Uses the F1 bucket-set vocabulary shipped in PR #134 (`WON_STAGES`, `LOST_STAGES`, `PAYMENT_RECEIVED_STAGES` in `frontend/src/types/salesforce.ts`).

---

## 1. Why this is more subtle than "mechanical find-and-replace"

My morning pitch on 2026-04-17 framed this as "mostly mechanical — normalize hardcoded stage arrays to F1 sets". That framing was wrong in three ways:

1. **`Overview.tsx:76` is NOT a normalization target** despite what `tasks/stage-schema-drift.md` item 4 says ("actively correct; keep"). The 6-entry substring array includes `'In Collection'` and `'Collecting'`. The latter substring catches both `'Collecting / In Effect'` (philanthropy, 47 records) AND `'In Collection'` (ISA RecordType legacy, 650 records). So the array is stale against the 2026-04-16 ISA-out-of-scope finding. The "keep" note predates that finding.
2. **`GOAL_STAGES` normalization is BLOCKED** by an open product call. `PAYMENT_RECEIVED_STAGES = {'Closed / Completed', 'Closed Won'}` includes Donorbox. `GOAL_STAGES = ['Collecting / In Effect', 'Closed / Completed']` excludes it. Replacing `GOAL_STAGES` with `PAYMENT_RECEIVED_STAGES` changes whether Donorbox donations count toward individual fundraiser goals — that's a JP + team decision, not a refactor.
3. **`closedStages` at `Opportunities.tsx:208` is semantically "trigger recently-changed animation on close"** — a different bucket than `LOST_STAGES` or `WON_STAGES`. It's missing `'Closed Won'`, which means transitioning TO Donorbox wins doesn't trigger the close animation. Widening it is a behavior change, not a no-op.

## 2. Complete drift-site inventory (9 sites)

Verified by direct read 2026-04-17. Each entry below includes current code, the F1 set it should reference (if applicable), and a recommended action.

### 2.1 `frontend/src/pages/Overview.tsx:76` — `CLOSED_WON_STAGES`

```ts
const CLOSED_WON_STAGES = ['Closed Won', 'Closed / Completed', 'Collecting / In Effect',
                           'Collecting', 'In Collection', 'In Effect'];
```

**Used at:** lines 192, 254, 260, 279 — matched via `.some(stage => opp.StageName?.includes(stage))` (substring).

**Problem:** ISA contamination. `'Collecting'` substring catches ISA's `'In Collection'`. `'In Collection'` explicit entry does too.

**Recommended action:** replace with `WON_STAGES.has(opp.StageName)`. Drops the 6-entry substring-match pattern in favor of O(1) set membership on the canonical string.

**Risk:** moderate. The substring match was defensive against unknown stages. Post-PR #134, `WON_STAGES` is authoritative. But anything not in `WON_STAGES` currently counted as "won" (e.g., a PBC variant like `'Closed / Full-Time or Successful Conversion'`) would stop being counted. That's arguably correct behavior but should be verified against Pursuit's historical metrics. Cross-reference `tasks/stage-schema-drift.md` PBC variants list before shipping.

### 2.2 `frontend/src/pages/Overview.tsx:476` — `GOAL_STAGES`

```ts
const GOAL_STAGES = useMemo(() => ['Collecting / In Effect', 'Closed / Completed'], []);
```

**Used at:** line 511 — `GOAL_STAGES.includes(o.StageName)` — for per-owner wins calculation in `ownerProgress` memo.

**Problem:** excludes Donorbox (`'Closed Won'`).

**Recommended action:** **BLOCKED. Do not touch until JP answers the Donorbox goal-inclusion question** (`tasks/stage-schema-drift.md` item 5). Two forks:
- If JP says "Donorbox counts toward individual goals": replace `GOAL_STAGES` with `PAYMENT_RECEIVED_STAGES` (which is `{Closed / Completed, Closed Won}`). Note: this swaps out `Collecting / In Effect` (in-flight collections) — need to decide if in-flight also counts. Might want a new `GOAL_STAGES_SET = COLLECTING_STAGES_SET | PAYMENT_RECEIVED_STAGES_SET` set in `salesforce.ts`.
- If JP says "Donorbox does NOT count": current behavior is correct; add a comment pointing at the decision.

### 2.3 `frontend/src/components/GoalTracker.tsx:6` — `GOAL_STAGES`

```ts
const GOAL_STAGES = ['Collicting / In Effect', 'Closed / Completed'];
```

**Used at:** line 43 — same pattern as Overview.tsx.

**Recommended action:** same as §2.2 — blocked on same product call. Normalize identically to Overview.tsx once unblocked.

### 2.4 `frontend/src/pages/Opportunities.tsx:208` — `closedStages`

```ts
const closedStages = ['Withdrawn', 'Closed Lost', 'Closed / Did not Fulfill', 'Closed / Completed'];
```

**Used at:** line 209 — `if (closedStages.includes(newStage)) markRecentlyChanged(oppId);` — triggers the "recently changed" UI highlight when an opp is moved to a closed stage.

**Problem:** missing `'Closed Won'`. Moving an opp to Donorbox-won doesn't trigger the UI highlight.

**Recommended action:** replace with `WON_STAGES.has(newStage) || LOST_STAGES.has(newStage)`. Or introduce a new `TERMINAL_STAGES = WON_STAGES ∪ LOST_STAGES` set in `salesforce.ts` if this combined notion is needed elsewhere (it is — see §2.6, §2.7).

**Risk:** low. Adds animation trigger for Donorbox transitions. No data-correctness impact.

### 2.5 `frontend/src/pages/Opportunities.tsx:305` — view-mode filter (substring)

```ts
if (viewMode === 'collecting') {
  return opportunities.filter((opp) => {
    const s = opp.StageName || '';
    return s.includes('Collecting') || s.includes('In Effect');
  });
}
```

**Problem:** `.includes('Collecting')` catches both `'Collecting / In Effect'` (want) and `'In Collection'` (ISA, don't want). `.includes('In Effect')` catches the same thing.

**Recommended action:** replace with `COLLECTING_STAGES_SET.has(opp.StageName)`. The `COLLECTING_STAGES_SET` in `models.py` is `{'Collecting / In Effect'}` — exact match, no ISA bleed.

**Risk:** low. Post-RecordType-audit (see `tasks/recordtype-audit-post-mvp.md`), ISA records won't be in the frontend dataset anyway. This fix is still worth doing for defense-in-depth.

### 2.6 `frontend/src/pages/Accounts.tsx:128-136` — hardcoded local `OPEN_STAGES` duplicate

```ts
const OPEN_STAGES = [
  'Lead Gen', 'New Lead', 'Qualifying',
  'Design / Proposal Creation', 'Proposal Negotiation',
  'Contract Creation', 'Negotiating Contract'
];
```

**Problem:** duplicates the imported canonical `OPEN_STAGES` from `types/salesforce.ts:63`. Silent drift risk — if the canonical definition changes, this local copy won't.

**Recommended action:** delete the local const; import `OPEN_STAGES` from `types/salesforce.ts`. Zero-risk mechanical fix.

### 2.7 `frontend/src/pages/Accounts.tsx:346-350` — substring `isWon` check

```ts
const isWon = opp.StageName.includes('Closed Won') ||
              opp.StageName.includes('Closed / Completed') ||
              opp.StageName.includes('Collecting') ||
              opp.StageName.includes('In Collection');
```

**Problem:** `.includes('In Collection')` explicitly includes ISA. `.includes('Collecting')` substring bleeds ISA too. Double contamination.

**Recommended action:** replace with `WON_STAGES.has(opp.StageName)`. Drops the 4-clause substring match.

**Risk:** moderate. ISA records currently show as "won" in the Accounts page's funder-history rollups. This changes that. If Pursuit's fundraising team uses the Accounts page to see ISA-cohort historical metrics (unlikely — ISA is out-of-scope for philanthropy MVP), they'd notice the drop. Verify with JP before shipping.

### 2.8 `frontend/src/pages/Accounts.tsx:619-624` — same `isWon` pattern

Same code as §2.7 but in the `wonOpps` filter inside the Account detail dialog. Same fix, same risk notes.

### 2.9 `frontend/src/pages/PaymentProcessing.tsx:90-94` — substring "closed deals" filter

```ts
const closedDeals = opportunities?.filter((opp: Opportunity) => {
  const stage = opp.StageName || '';
  return stage.includes('Collecting') ||
         stage.includes('Closed Won') ||
         (stage.includes('Closed / Completed') && (opp.Outstanding_Payments__c || 0) > 0);
});
```

**Problem:** `.includes('Collecting')` bleeds ISA. The `Closed / Completed + Outstanding > 0` clause is a conditional with business logic that doesn't map cleanly to any F1 set.

**Recommended action:** split the conditional. Use `WON_STAGES.has(stage) && (stage === 'Closed / Completed' ? opp.Outstanding_Payments__c > 0 : true)`, or more clearly:
```ts
return WON_STAGES.has(stage) && (
  stage !== 'Closed / Completed' || (opp.Outstanding_Payments__c || 0) > 0
);
```

The intent: show everything in a "won" state, but for fully-paid `Closed / Completed` deals, only show them if they still have outstanding payments. Donorbox (`Closed Won`) skips that gate because it's already settled via Stripe. `Collecting / In Effect` shows always because it's actively collecting.

**Risk:** moderate. Requires careful semantic preservation. Recommend pair-reviewing with JP.

## 3. Recommended PR structure

Break this into 3 sequential PRs — they have different blockers and risk profiles.

### PR A — Unambiguous, low-risk fixes (ship first)

- §2.6 — delete `Accounts.tsx:128` duplicate, import from canonical
- §2.4 — `Opportunities.tsx:208` include `Closed Won` via `WON_STAGES ∪ LOST_STAGES`
- §2.5 — `Opportunities.tsx:305` substring → `COLLECTING_STAGES_SET.has`

Estimated time: 1–2 hours including tests. No blockers.

### PR B — ISA-contamination substring fixes (ship after or with RecordType audit)

- §2.1 — `Overview.tsx:76` `CLOSED_WON_STAGES` → `WON_STAGES.has`
- §2.7 — `Accounts.tsx:346-350` `isWon` → `WON_STAGES.has`
- §2.8 — `Accounts.tsx:619-624` same
- §2.9 — `PaymentProcessing.tsx:90-94` split conditional + use `WON_STAGES.has`

Estimated time: 3–4 hours including visual QA of affected pages (Progress / Accounts / PaymentProcessing).

**Sequencing note:** post-MVP RecordType audit (see `tasks/recordtype-audit-post-mvp.md`) makes PR B partially moot — ISA records won't be in the dataset. Either ship PR B first as defense-in-depth, or fold it into the RecordType audit's PR as a single coherent change. My lean is **fold into RecordType audit** since they touch the same pages; PR B's standalone value without the audit is marginal.

### PR C — Donorbox-blocked `GOAL_STAGES` normalization (ship after product call)

- §2.2 — `Overview.tsx:476` `GOAL_STAGES`
- §2.3 — `GoalTracker.tsx:6` `GOAL_STAGES`

Estimated time: ~30 min once JP answers the question. Potentially includes adding a new `GOAL_STAGES_SET` to `salesforce.ts` if Donorbox-counts-toward-goals is true.

## 4. Open questions JP needs to resolve

These should be answered in the kickoff session of a fresh shell, before PR B or PR C touches any code:

1. **Donorbox goal-inclusion.** Should `Closed Won` (Donorbox) count toward individual fundraiser goals in the Wall of Progress? Currently excluded (`GOAL_STAGES = [Collecting / In Effect, Closed / Completed]`). Blocks PR C.
2. **In-flight contracts counted toward goals?** Currently `Collecting / In Effect` IS in `GOAL_STAGES`. Keep? (This is separate from the Donorbox question.)
3. **Accounts page ISA visibility.** When PR B removes ISA records from Accounts.tsx's "won" rollups, any chance team members use that view for ISA-cohort historical review? Very unlikely given ISA is out-of-scope for philanthropy, but worth a quick confirm.
4. **PBC-variant stage handling.** The 7 PBC-variant stages (see `tasks/stage-schema-drift.md` §1) are currently NOT in `WON_STAGES` / `LOST_STAGES`. After PR B ships, they'd fall into the "unknown" bucket. For MVP philanthropy, that's fine (they're out of scope). Post-MVP PBC sprint needs to add them.
5. **Should `CLOSED_STAGES` in `salesforce.ts:77-82` be widened?** Currently 4 entries (Closed Lost, Withdrawn, Did not Fulfill, Closed / Completed). Doesn't include `Closed Won`. Several consumers rely on its array semantics (`.includes()`, spread). Three options:
   - Add `Closed Won` to the readonly array. Breaks type-tightness (`Closed Won` isn't in the `OpportunityStage` union).
   - Add a parallel `CLOSED_STAGES_SET` (`ReadonlySet<string>`) for reporting uses; keep array for dropdown/UI uses. Aligns with F1 pattern.
   - Leave `CLOSED_STAGES` alone; callers use `WON_STAGES ∪ LOST_STAGES` where they need the combined notion.

## 5. Verification approach (for when this is picked up)

- Start by reading this doc end-to-end + `tasks/stage-schema-drift.md` item 4 + F1 plan at `tasks/f1-stage-buckets-plan.md`.
- Re-verify each drift site's current code — some sites may have moved lines since 2026-04-17.
- Before shipping PR B, run the full test suite and visually QA Progress / Accounts / PaymentProcessing pages both before and after the change to confirm the "won" bucket rollups don't shift unexpectedly. Key numbers to sanity-check: Overview page's `totalWins`, `winRate`, FY wins; Accounts page's per-funder "Amount Won" column.

## 6. Session context: why this was parked

JP direction 2026-04-17: "OK option 2, but run 4 more verification passes to be absolutely certain. And yes, then let's do the remaining 3 fixes the right way." — at that point Candidate #3 was parked in favor of finishing the test-fixture fixes (PR #137). JP's follow-up: "Let's do the candidate 3 thoroughly in a new shell."

Then pivoted to MVP bug fixes: "OK I have bugs to fix for the MVP. Let's save all this remaining work somewhere so we don't lose it for later."

That's the trail. Pick this up after MVP bugs are under control.
