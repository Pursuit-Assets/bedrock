# Data Cleanup Pass — Account / Contact / Activity Mapping & Enrichment

**Status:** planning
**Created:** 2026-06-06
**Blocks:** `tasks/candidate-funnel-plan.md`

## Goal

Before introducing the candidate funnel, make sure every account / contact / activity already in our universe is correctly mapped, deduplicated, and enriched. This pass operates *only* on what already exists in SF, `public.companies`, `public.contacts`, `bedrock.activity`, and `bedrock.account_email_domain`. No new tables, no schema changes — just hygiene.

Why first: the candidate funnel's promotion logic relies on "if no SF Account / public.companies match exists, create a candidate." If the existing universe is full of unlinked rows that *should* match, the candidate table will fill with false positives and dedup will be impossible.

## Scope (in)

1. Audit + fix mapping between SF Accounts and `bedrock.account_email_domain`.
2. Audit + fix mapping between SF Contacts (and their email domains) and SF Accounts.
3. Audit + fix mapping between `public.contacts` ↔ SF Contacts via `sf_contact_link`.
4. Audit + fix mapping between `public.companies` ↔ SF Accounts via `sf_account_company_map`.
5. Backfill `account_id` on `bedrock.activity` rows that are currently NULL but resolvable now.
6. Identify and flag (do not auto-merge) likely-duplicate SF Accounts and SF Contacts.
7. Enrichment pass: pull missing logos, industries, employee counts from `public.companies` into the joined view.

## Scope (out)

- Creating new SF Accounts / Contacts.
- Writing to `public.companies` / `public.contacts` (deferred to candidate-funnel plan).
- Resolving the prospect-scoring / business-motion layer.
- Any UI changes — this is a backend hygiene pass.

## Pass 1 — Domain map completeness

**Status (2026-06-07):** steps 1 + 2 applied. Total `bedrock.account_email_domain` rows: 1,638 → 1,815 (+177). Conflict report: `/tmp/pass1_sf_contact_conflicts.csv` (12 external conflicts + 10 multi-account domains for RM review — most are duplicate SF Accounts surfaced for Pass 5).

Goal: `bedrock.account_email_domain` should contain a row for every domain we can reasonably attribute to an SF Account.

Inputs:
- `Salesforce.Account.Website` (one-time + ongoing).
- `Salesforce.Contact.Email` joined to `Salesforce.Contact.AccountId` (every contact's email implies a domain → account mapping).
- `public.contacts.sf_contact_link` for alumni who work at SF Accounts.

Process:

1. **Run `scripts/seed_account_email_domains`** (already exists). Re-extracts eTLD+1 from `Account.Website` across all SF Accounts. Records pre/post counts. **[done — 1,638 → 1,643 on 2026-06-07]**
2. **Auto-link from SF Contacts.** **[done — implemented in `scripts/pass1_sf_contact_domain_backfill.py`; 1,643 → 1,815 on 2026-06-07]**
   ```sql
   -- pseudocode; needs SF query, not SQL
   for contact in SF Contacts where Email is not null and AccountId is not null:
       domain = normalize_domain(contact.Email)
       if domain not in bedrock.account_email_domain
           or bedrock.account_email_domain[domain] != contact.AccountId:
           append to proposed_mappings
   ```
   Output a report:
   - `domain → AccountId` rows already correct (idempotent, no action)
   - `domain → AccountId` rows missing — to be inserted
   - `domain` rows with conflict (currently mapped to a *different* AccountId) — flag for human review (don't auto-overwrite)
3. **Auto-link from `public.contacts`** that have `sf_contact_link.sf_account_id` set. Same pattern.
4. **Apply the non-conflicting inserts.** Conflicts surfaced in a CSV for triage.

Acceptance: % of unique domains seen in `bedrock.activity` (last 90 days) that resolve to an SF Account jumps from current X% to Y%. Measure before and after.

## Pass 1.5 — sf_contact_link.sf_account_id backfill

**Status (2026-06-07):** done. 889 of 889 sf_contact_link rows that were missing sf_account_id were backfilled. Coverage: 14% → **100%** (144 → 1,033 rows with sf_account_id).

849 of the 889 update targets were Household accounts (individual donors). Households are intentionally not skipped here because the bridge is 1:1 (a specific public.contact linked to a specific SF Contact's actual AccountId — no fan-out risk like the domain map has).

Script: `scripts/pass1_5_backfill_link_account_id.py`. Report: `/tmp/pass1_5_link_account_backfill.csv`.

## Pass 2 — Contact bridge completeness

Goal: every SF Contact has a `public.contacts.sf_contact_link` row, and every `public.contacts` row whose email matches an SF Contact email is correctly linked.

Process:

1. **Forward link** — for every SF Contact with an Email, check if `public.contacts` has a row by that email. If yes and no `sf_contact_link`, propose insertion.
2. **Reverse link** — for every `public.contacts` row without a `sf_contact_link`, check if SF has a Contact by that email. Same proposal pattern.
3. **Conflict detection** — emails that exist in both but link to *different* SF Contacts (rare; usually means a duplicate SF Contact). Flag for review.

Output: CSV of (proposed insertions, conflicts). Apply insertions in batch.

## Pass 3 — Account ↔ Companies bridge

Goal: `sf_account_company_map` is populated wherever `public.companies` has a matching domain to an SF Account.

Process:

1. For every SF Account with a `Website`, normalize the domain.
2. Look up `public.companies.domain` for matches.
3. Propose `sf_account_company_map` insertions for unmapped pairs.
4. Conflict cases (one SF Account → multiple public.companies rows by domain, or vice versa) → human review.

Output: report + apply non-conflicting.

## Pass 4 — Activity backfill

After Pass 1–3 land, re-resolve `bedrock.activity` rows where `account_id IS NULL`:

```sql
UPDATE bedrock.activity a
SET account_id = aed.sf_account_id
FROM bedrock.account_email_domain aed
WHERE a.account_id IS NULL
  AND a.email_domain = aed.domain;
```

…and similar for participant resolution (sender email → sf_contact_id via the bridge).

Measure: count of NULL `account_id` activity rows before vs after.

## Pass 5 — Duplicate detection (advisory)

Goal: surface (don't merge) likely-duplicate SF Accounts and Contacts.

Inputs:
- All SF Accounts with `Website` / normalized name.
- All SF Contacts with `Email`.

Process:

1. **Account dedup candidates.** For each SF Account, compute a normalized name (`strip(Inc.|LLC|Corp), lower, collapse_ws`). Group by normalized name → groups of size ≥ 2 are dedup candidates.
2. **Account dedup by domain.** Same eTLD+1 → another flag source.
3. **Contact dedup candidates.** Same email → group. Same normalized name + same AccountId → group.
4. **Output a single report file** (CSV / JSON) listing every dedup candidate group with: SF Ids, Names, Owners, last activity dates, opp counts. RM team reviews and decides; this pass does *not* auto-merge.

## Pass 6 — Enrichment audit

Goal: every SF Account has access (via the bridge) to enrichment data (logo, industry, employee count) when available.

Process:

1. For each SF Account → check `public.companies` via `sf_account_company_map` → are key enrichment fields populated?
2. For SF Accounts with NO public.companies link AND no enrichment → list them. These are the candidates for future enrichment (manual lookup, or a Bedrock-side enrichment job once writeback is enabled).

Output: a CSV of "SF Accounts missing enrichment" + a count by record-type / tier so we know how big the gap is.

## Execution order

Sequential. Each pass produces a report; apply non-conflicting changes before moving on (so later passes see the latest state).

1. Pass 1 — domain map (writes to `bedrock.account_email_domain`)
2. Pass 2 — contact bridge (writes to `public.contacts.sf_contact_link`)
3. Pass 3 — companies bridge (writes to `sf_account_company_map`)
4. Pass 4 — activity backfill (writes to `bedrock.activity.account_id`)
5. Pass 5 — duplicate detection (read-only, advisory report)
6. Pass 6 — enrichment audit (read-only, advisory report)

After Pass 6, the universe is as clean as it can get without manual review of the duplicate reports. The candidate funnel can then layer on top.

## Risks

- **`public.contacts.sf_contact_link` writes** — this is in segundo-db (shared with factory). Confirm we have write authorization before Pass 2. (Factory has been writing here already, so the precedent exists, but get a quick sign-off.)
- **Conflicting domain mappings** — if a domain currently maps to AccountA but SF Contacts data suggests AccountB, we must NOT auto-overwrite. Conflict report → human review only.
- **Stale data** — SF Accounts that were deleted/merged in SF but their old Ids linger in our mappings. The passes should filter on "AND deleted_at IS NULL" / SF IsDeleted = false where relevant.
- **Volume** — 20k SF Accounts × 200k+ SF Contacts means batched queries with pagination. Don't blow the SF API daily limit (5M API calls/day, but watch concurrent burst).

## Acceptance criteria

- ≥ 90% of unique domains seen in `bedrock.activity` (last 90 days) resolve to an SF Account.
- ≥ 95% of SF Contacts with an email have a `public.contacts.sf_contact_link` row.
- 100% of SF Accounts with a `Website` are evaluated for `public.companies` linkage.
- Duplicate-candidate report exists and has been reviewed by RM lead.
- Enrichment-gap report exists.
- Total `bedrock.activity` rows with `account_id IS NULL` decreases by at least 50%.

## Build order (concrete tasks)

Each task is a standalone PR.

1. **Audit-only scripts first.** Write `scripts/audit_domain_map.py`, `audit_contact_bridge.py`, `audit_company_bridge.py`, `audit_duplicates.py`, `audit_enrichment_gap.py`. Each produces a CSV. **Read-only.** This lets us see the gap before any writes.
2. Review the audit reports with RM team. Adjust acceptance thresholds if needed.
3. **Apply-mode scripts** that take the CSV from #1 and apply the non-conflicting changes idempotently. Each apply-script must support `--dry-run`.
4. Run apply scripts in production, in order (Pass 1 → 4). Each prints before/after counts.
5. Re-run the audits to confirm acceptance criteria met.
6. Hand the duplicate + enrichment reports to RM team / factory team for follow-up.

## Out-of-band items to flag to the team

- Factory team: are they OK with Bedrock writing to `sf_contact_link` and `sf_account_company_map`? Brief sync needed before Pass 2 + 3.
- RM team: who reviews the duplicate report? Need a designated person before Pass 5 lands.
- Are there any SF Validation Rules that would block a bulk update to Account / Contact? (We're not updating SF in this pass, but the activity backfill referencing SF Ids assumes the SF Ids are still valid — check.)
