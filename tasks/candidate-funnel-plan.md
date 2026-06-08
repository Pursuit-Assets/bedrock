# Candidate Funnel — Multi-Source Account + Contact Unification

**Status:** Steps 2 + 3 shipped (2026-06-07). See [Shipped today](#shipped-today) below.
**Created:** 2026-06-06
**Precondition:** Data Cleanup Pass (`tasks/data-cleanup-pass.md`) — Pass 1 + Pass 1.5 done; Passes 2–6 still planned but not blocking the funnel.

## Shipped today

| Piece | Where | Notes |
|---|---|---|
| Migration | `db/migrations/2026-06-07-add-candidate-funnel.sql` | `bedrock.account_candidate`, `bedrock.contact_candidate`, 4 activity attribution cols. Soft FKs to `public.*` (no REFERENCES privilege). |
| Seed | `scripts/seed_candidate_funnel.py` | UPSERT from `activity_scan_*`. `status` never overwritten on re-run — reviewed candidates keep their state. Seeded 2,252 accounts + 7,231 contacts. |
| API | `routes/candidates.py` | GET list (both); POST `/track`, `/promote-sf`, `/tag-existing`, `/reject` (both). Wired in `main.py`. |
| UI | `frontend-v2/src/pages/CandidateFunnel.tsx`, `services/candidates.ts` | Tabs Companies/People, filter pills (status/SF-bucket/min-signal/search), inline action buttons via `window.prompt` (modal upgrade is a follow-up). `/candidates` route + nav link added. |
| Refresh | `scripts/refresh_candidate_funnel.py` | Nightly wrapper that re-runs scan + seed. Idempotent. Run via cron / Cloud Scheduler. |

**Deferred / next session:**
- Step 4: `public.companies` / `public.contacts` writeback (factory team coordination on provenance + dedup).
- Step 5: nightly dedup sweep (subdomain rollup, alumni bridge, fuzzy name).
- Step 6: bulk actions (reject-all-noise, mass-promote-by-filter).
- UX upgrade: replace `window.prompt` calls in `CandidateFunnel.tsx` with proper modals that use the existing `AccountPicker` / `ContactPicker` components for "Tag to existing".
- Real-time write-through from `services/gmail_sync.py` + `services/calendar_sync.py` (currently funnel refreshes nightly via the wrapper).

## Goal

Surface every company and person Pursuit has touched — across Salesforce, `public.companies`, `public.contacts`, and Gmail/Calendar activity — as a single reviewable funnel. Auto-create candidate records for anyone we've corresponded with but haven't yet tracked, give RMs a triage UI to promote / merge / reject them, and route promotions correctly to SF and the Pursuit-wide registry.

## Background

Today the Gmail/Calendar DWD sync writes `bedrock.activity` rows with `account_id = null` whenever the sender's domain isn't in `bedrock.account_email_domain`. Those signals (companies we keep meeting with but haven't created accounts for) just sit there. There's no system surface to promote them.

`public.companies` and `public.contacts` live in segundo-db and are populated by factory's pipelines (alumni employers, central contact registry). They're great enrichment sources but don't currently capture "company we've been emailing." Bedrock can now write to these tables (per 2026-06-06 product decision) — but with a coordinated provenance contract.

Salesforce is the source of truth for the deal pipeline. We never want random Gmail sender domains becoming SF Accounts automatically; the candidate funnel exists to mediate.

## Mental model

```
                  ┌─────────────────────────────────┐
                  │  Gmail / Calendar activity      │
                  └─────────────────────────────────┘
                                 │
                                 ▼
       ┌─────────────────────────┴─────────────────────────┐
       │   Bedrock candidate funnel                          │
       │   ┌─────────────────────┐  ┌──────────────────┐   │
       │   │ account_candidate   │──│ contact_candidate│   │
       │   └─────────────────────┘  └──────────────────┘   │
       └────────────────┬─────────────────────┬──────────────┘
                        │ promote              │ promote
           ┌────────────┴───────────┐  ┌───────┴────────┐
           ▼                        ▼  ▼                ▼
    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │ public.companies │  │ public.contacts  │  │  Salesforce      │
    │ (factory shared) │  │ (factory shared) │  │  Account/Contact │
    └──────────────────┘  └──────────────────┘  └──────────────────┘
             ▲                      ▲                     ▲
             └─────── bridge ───────┴──── sf_*_link ───────┘
```

Bedrock owns the **candidate funnel** (lifecycle: new → tracking → promoted/merged/rejected). `public.*` are the **canonical registries** (Pursuit-wide truth). Salesforce is the **deal layer** (revenue / pursuit).

## Resolution chain (per-participant, per activity row)

For every Gmail/Calendar event, for every participant (sender + each recipient/attendee):

```
1. email → public.contacts → sf_contact_link → SF Contact?
     → activity.participant_sf_contact_id = <id>
     → activity.account_id = <linked SF Account>     (existing path)

2. email → public.contacts (no SF link)?
     → activity.participant_public_contact_id = <id>
     → activity.account_id = resolve_via_account_email_domain(email_domain)

3. email → bedrock.contact_candidate → existing?
     → bump signal_count, set last_seen_at
     → activity.participant_candidate_id = <id>

4. Otherwise:
     → upsert bedrock.contact_candidate (email, display_name, first_source)
     → resolve account_candidate by domain
     → link contact_candidate.account_candidate_id (if account is also a candidate)
       OR contact_candidate.sf_account_id (if account is a known SF Account)
     → activity.participant_candidate_id = <new id>
```

For the **account** side, the same chain but keyed on domain → `bedrock.account_email_domain` → SF Account ELSE candidate.

## Schema

### `bedrock.account_candidate`

```sql
CREATE TABLE bedrock.account_candidate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (one row per unique company)
  primary_domain  citext NOT NULL UNIQUE,        -- dedup key
  display_name    text,                           -- inferred from email signatures / invite org
  alt_domains     text[] DEFAULT '{}',            -- subdomains, ccTLDs, prior names

  -- Provenance
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  first_source    text NOT NULL,                  -- 'gmail-sync' | 'calendar-sync' | 'manual' | 'airtable-import'
  signal_count    int  NOT NULL DEFAULT 0,        -- activity rows touching this candidate
  unique_people   int  NOT NULL DEFAULT 0,        -- distinct people we've corresponded with at this domain

  -- Linkage
  public_company_id uuid REFERENCES public.companies(id),
  sf_account_id   text,                           -- 18-char SF id, set when promoted
  merged_into_id  uuid REFERENCES bedrock.account_candidate(id),

  -- Lifecycle
  status          text NOT NULL DEFAULT 'new',
    -- 'new' | 'tracking' | 'in_registry' | 'promoted' | 'merged' | 'rejected'
  reviewed_by     text,
  reviewed_at     timestamptz,
  notes           text
);
CREATE INDEX ON bedrock.account_candidate (status);
CREATE INDEX ON bedrock.account_candidate (LOWER(primary_domain));
CREATE INDEX ON bedrock.account_candidate (sf_account_id) WHERE sf_account_id IS NOT NULL;
```

### `bedrock.contact_candidate`

```sql
CREATE TABLE bedrock.contact_candidate (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  email                 citext NOT NULL UNIQUE,
  display_name          text,
  first_seen_at         timestamptz DEFAULT now(),
  last_seen_at          timestamptz DEFAULT now(),
  first_source          text NOT NULL,
  signal_count          int  DEFAULT 0,

  account_candidate_id  uuid REFERENCES bedrock.account_candidate(id),
  sf_account_id         text,
  sf_contact_id         text,
  public_contact_id     uuid REFERENCES public.contacts(id),

  status                text NOT NULL DEFAULT 'new',
    -- 'new' | 'tracking' | 'in_registry' | 'promoted' | 'merged' | 'rejected'
  reviewed_by           text,
  reviewed_at           timestamptz,

  title                 text,
  linkedin_url          text
);
CREATE INDEX ON bedrock.contact_candidate (LOWER(email));
CREATE INDEX ON bedrock.contact_candidate (account_candidate_id);
CREATE INDEX ON bedrock.contact_candidate (sf_account_id);
```

### `bedrock.activity` additions

```sql
ALTER TABLE bedrock.activity
  ADD COLUMN account_candidate_id uuid REFERENCES bedrock.account_candidate(id),
  ADD COLUMN participant_candidate_id uuid REFERENCES bedrock.contact_candidate(id),
  ADD COLUMN participant_public_contact_id uuid REFERENCES public.contacts(id),
  ADD COLUMN participant_sf_contact_id text;
```

(Participant attribution gets first-class storage — today it's only inferred via the activity's join.)

## Promotion flow — UI surface

Each candidate row offers four outcomes:

| Button | What it does |
|---|---|
| **Track in registry only** | Ensures a `public.companies` / `public.contacts` row exists (creates if needed, links to candidate). Skips SF entirely. Candidate `status='in_registry'`. Useful for vendors / partners / alumni employers — companies Pursuit should know about but isn't selling to. |
| **Open as SF Account / Contact** | Ensures the public.* row exists, then creates the SF Account / Contact via existing endpoints (pre-filled from public.* data when available). Links via `sf_account_company_map` / `sf_contact_link`. Backfills activity rows from `candidate_id` → `account_id` / `sf_contact_id`. Candidate `status='promoted'`. |
| **Tag to existing SF record** | For dedup-pass hits. Links the candidate to a known SF Account/Contact. Writes `primary_domain` (and any alts) to `bedrock.account_email_domain`. Backfills activity. Candidate `status='merged'`. |
| **Reject** | Mark noise. Future activity from this domain/email is still recognized (we keep the rejection so the candidate isn't recreated). |

UI layout:
```
┌─────────────────────────────────────────────────────────────────┐
│ acme.com                                                         │
│ "Acme Inc."                                                      │
│ 7 emails · 2 meetings · 3 distinct people                        │
│                                                                  │
│ 📁 Pursuit registry: matches Acme Inc. (12 alumni, logo)         │
│ ⚠ No Salesforce Account yet                                      │
│                                                                  │
│ Possible duplicate of:                                           │
│   • Acme Holdings (SF Account 001…)                              │
│                                                                  │
│ [Track in registry only] [Open as SF Account]                    │
│ [Tag to existing SF acct] [Reject]                               │
└─────────────────────────────────────────────────────────────────┘
```

Filters: status, source, signal threshold (default ≥ 3 touches), unreviewed only, motion fit (jobs / philanthropy / PBC — populated by scoring layer when added).

Routes:
- `/accounts/candidates` (account-level)
- `/contacts/candidates` (contact-level) — or a tab on the same page

## Dedup smarts

Four passes, layered cheapest → most expensive:

1. **Normalized domain match (on every write).**
   - Lowercase, strip leading `www.`, drop known subdomain prefixes (`mail.`, `mx.`, `smtp.`).
   - Public-suffix-list aware (`acme.co.uk` ≠ `co.uk`).
   - If already a candidate → bump counters. If in `account_email_domain` → skip candidate creation entirely.

2. **Subdomain rollup (nightly).**
   - If a candidate's `primary_domain` is a strict subdomain of another candidate's domain, merge into the parent.

3. **Alumni / contact bridge (nightly).**
   - For every candidate, check if `public.contacts` has people at that domain who are linked to an SF Account → auto-flag as probable merge target (don't auto-merge).

4. **Fuzzy name match (nightly, advisory).**
   - Normalize names (strip `Inc.`, `LLC`, `Corp`, lowercase, collapse whitespace). Levenshtein < threshold → propose merge. Never auto-merge on name alone.

The same four passes apply to `contact_candidate`, keyed on email/name rather than domain.

## `public.companies` / `public.contacts` writeback contract

Bedrock writes are allowed (2026-06-06 decision) but require coordination with the factory team on:

- **Provenance column.** Add (or use existing) `created_by_system` / `last_updated_by_system` to distinguish "Bedrock activity discovery" rows from "factory imported" rows.
- **Dedup contract.** Both Bedrock and factory may create the same company at the same time. Default: earlier `first_seen` wins; the other becomes an alias. Use `INSERT … ON CONFLICT (domain) DO UPDATE`.
- **Column ownership.** Signal fields (`activity_count`, `last_email_at`) are Bedrock's; canonical fields (primary name, logo) are factory's. Don't stomp.
- **Cascades.** If factory deletes a `public.companies` row Bedrock has linked from `account_candidate` / `account_email_domain`, Bedrock must handle gracefully.

Sync session with factory data ingest owners required before flipping the writeback switch.

## Build order

0. **Data Cleanup Pass** — see `tasks/data-cleanup-pass.md`. Must complete before #1.
1. **Hygiene backfills** (no schema changes): SF-Contact-email-domain auto-link + Account.Website re-seed + soft validation pass. Drops the unknown-rate substantially before any new table exists.
2. **Candidate tables** (`account_candidate`, `contact_candidate`) + activity column additions. Update `gmail_sync` / `calendar_sync` to follow the 4-step resolution chain and write candidates.
3. **Candidate review UI** (`/accounts/candidates`, `/contacts/candidates`) — the four-outcome cards.
4. **`public.*` writeback authorization** — wire up INSERT/UPDATE paths from candidate promotion. Provenance + dedup coordination with factory.
5. **Dedup sweep job (nightly)** — subdomain rollup, alumni bridge, fuzzy name match (advisory).
6. **Bulk actions** — reject-all-noise, mass-promote-by-filter.

Sequence 1–3 ships the "see everything we've ever seen, decide what to do with it" experience in ~1.5 weeks. Then 4 unlocks the registry-write story, and 5 keeps it tidy at scale.

## Open questions / decisions to confirm

- Coordination with factory team on `public.*` writeback contract.
- Whether to expose the candidate funnel publicly to all RMs or gate behind an admin role initially.
- Whether "Track in registry only" should also create a stub SF Account (lightweight) for reporting completeness, or genuinely keep SF clean of non-pursuit records.
- Scoring layer (signals → prospect score per business motion) is out of scope for this plan — separate doc once funnel is shipped.
