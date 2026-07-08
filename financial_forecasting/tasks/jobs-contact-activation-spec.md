# Build spec — Jobs contact activation + the contacts triage page

**Status:** ready to build. **Scope:** bedrock-only, additive, no platform sign-off, does NOT touch the nightly scraping pipeline. **Validated** against the 2026-07-08 code sweeps (platform never reads is_jobs_contact/contact_stage; account status is already derived; signals all readable from existing tables).

This is "Phase A" of the foundation plan (`account-dedupe-and-mirror-plan.md`). The deeper migration (drop is_jobs_contact, split contact_stage → contacts.status, SF consolidation, account sf_id/name_key, dedupe execution) is Phase B+, specced separately and NOT part of this.

---

## 1. The idea
Turn the ~40k contacts list into a working surface: sort/filter by the signals that justify outreach, then **bulk "Flag for jobs activation."** The flag creates a jobs-pipeline membership carrying the outreach funnel + owner. Flagged contacts roll up so their account shows as **Activating**.

Two status concepts, kept separate:
- **Record status** (person): active/candidate/dismissed/merged — *is this a real contact?* (Phase A leaves this as today's `contact_stage`; do not conflate.)
- **Jobs pipeline membership** (new): *are we working them for jobs, and where in the funnel?* Funnel lives here.

---

## 2. Schema — `bedrock.jobs_contact_membership` (NEW, additive)
```sql
CREATE TABLE bedrock.jobs_contact_membership (
  contact_id        integer PRIMARY KEY,               -- → public.contacts.contact_id (soft ref; no cross-schema FK)
  -- Funnel. Happy path: flagged → initial_outreach → active → handed_off.
  -- on_hold + not_a_fit are off-ramps reachable from any active stage.
  stage             text NOT NULL DEFAULT 'flagged'
                    CHECK (stage IN ('flagged','initial_outreach','active','handed_off','on_hold','not_a_fit')),
  owner_email       text,                              -- jobs-team owner of this contact
  activation_reason text CHECK (activation_reason IN ('manual','scraper_job','strategic','algorithm')),
  activation_note   text,
  -- WHO actually did the first outreach (may differ from owner — e.g. a connected
  -- staffer who made a warm intro). Sourced from the intro_request connector or the
  -- outreach activity's author. Powers "who's activating whom, don't double up."
  first_outreach_by            text,                   -- staff email
  first_outreach_at            timestamptz,
  first_outreach_intro_request_id uuid,                -- → bedrock.intro_request.id, if via a warm intro
  opportunity_id    uuid,                              -- set when stage='handed_off' (→ bedrock.jobs_opportunity)
  not_a_fit_reason  text,                              -- when stage='not_a_fit'
  flagged_by        text,
  flagged_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_jcm_stage   ON bedrock.jobs_contact_membership(stage);
CREATE INDEX idx_jcm_owner   ON bedrock.jobs_contact_membership(owner_email);
CREATE INDEX idx_jcm_outreach ON bedrock.jobs_contact_membership(first_outreach_by);
```
- **Existence = "flagged for jobs activation."** No row = cold (the 40k default).
- **Funnel order:** `flagged → initial_outreach → active → handed_off`; `on_hold` (paused) and `not_a_fit` (team pursued for jobs, didn't pan out) are off-ramps. `handed_off` = handed to the jobs team = an opportunity was created (can happen straight from `initial_outreach`, skipping `active`).
- **`not_a_fit` here ≠ the staff-edge "not a fit"** (`connection_status`). This one is the **jobs-pipeline outcome** (contact-level: "we worked this jobs lead, no fit"). `connection_status.status` is a **per-staff** pre-outreach read ("not a fit for *me* to pursue"). Different grain, both kept.

**Backfill (one-time):** insert a membership for every `public.contacts` where `is_jobs_contact = true`, mapping `contact_stage` → `stage` (`lead`→`flagged`, `initial_outreach`→`initial_outreach`, `active`→`active`, `on_hold`→`on_hold`, else `flagged`), `activation_reason='manual'`.

## 2b. Staff ↔ contact connection — two tables, kept separate
No new connection table. The staff-connection story stays as two, and the platform's Employment Engine owns the first — **do not merge**:

| Table | Owner | Holds | Change |
|---|---|---|---|
| `public.staff_contact_relationships` | platform (shared) | the connection edge exists; `relationship_strength`; `is_visible_to_builders` (builder-intro gate); `connected_date`; `source` (`linkedin_import`/`linkedin`) | **unchanged** |
| `bedrock.connection_status` | bedrock | per-staff **disposition**: "not a fit" / "can reach out" (`status`,`reason`,`note`) | unchanged |

Connection strength for the contacts page reads `staff_contact_relationships.relationship_strength` (coarse today — a uniform `'connection'` placeholder on all 34,648 rows; good enough to show the connector, and improvable later without a schema change).

## 2c. Intro requests ↔ the funnel ↔ outreach attribution
`bedrock.intro_request` already models the warm-intro ask: `contact_id`, `connector_staff_id` (**the connected staffer being asked to make the intro** — this is "who on staff is sent an intro request"), `requested_by_email` (the jobs person asking), `status` (pending→accepted→completed/declined/withdrawn). It ties to the funnel:
- Flagged contact → team finds the strongest connector (`staff_connection_linkedin.strength_score`) → **sends an intro request** to that `connector_staff_id`.
- When the connector makes the intro (request `completed`) **or** a staffer logs a direct outreach activity, the membership advances to `initial_outreach` and we stamp **`first_outreach_by`** = the connector (or the activity's author) + `first_outreach_at`, and link `first_outreach_intro_request_id` when it was a warm intro.
- So "**who did the initial outreach**" is a first-class, queryable field on the membership (derived from the intro request or the outreach activity), distinct from `owner_email` (the jobs-team owner). This is what powers Damon's "at a glance, who's activating whom — don't double up."

**Transition safety (no pipeline changes):** `is_jobs_contact` stays the source of truth for the nightly pipeline + existing metrics. A nightly reconcile ensures `is_jobs_contact=true ⇒ membership exists`; the bulk-flag action also sets `is_jobs_contact=true` (write-through). Phase B later flips reads to membership and drops the flag.

---

## 3. Account rollup (derived — one added signal, no new column)
In `GET /api/jobs/accounts` status derivation, add: an account with **≥1 contact whose membership stage ∈ (flagged, initial_outreach, active)** and no open opportunity derives to **Activating**. An account's **prospects** = its contacts that have a membership. `handed_off` implies an opportunity → already **Pursuing**. Bi-directional: account view offers "Flag these contacts."

---

## 4. API (bedrock, `routes/jobs.py`)
- `GET /contacts` — enrich each row with signals (see §6) + `membership: {stage, owner} | null`. New query params (all optional, combinable): `industry`, `min_strength`, `has_open_roles`, `warmth`, `stage`, `owner`, `flagged=true|false`. (Keeps existing paging/search.)
- `POST /contacts/flag-jobs` — bulk. Body `{contact_ids:[int], owner_email?, activation_reason='manual', note?}` → upsert memberships at `stage='flagged'` (don't downgrade an existing further stage); write-through `is_jobs_contact=true`. Returns count.
- `PATCH /jobs-membership/{contact_id}` — `{stage?, owner_email?}` (advance funnel / reassign).
- `DELETE /jobs-membership/{contact_id}` — unflag (remove row; clear `is_jobs_contact` if no other reason).
- `POST /accounts/{account_key}/flag-contacts` — flag all (or selected) contacts at an account.

---

## 5. Frontend — the contacts page (`frontend-v2/src/pages/jobs/JobsContacts.tsx`)
- **Columns:** Name · Title · Company (account link) · Industry · **Connection strength** (best score + top connector) · **Warmth** · **Open roles** (job postings at company) · **Stage** (membership, or "—") · **Owner** · **Reached out by** (`first_outreach_by`, if any).
- **Filters:** `Viable only` (saved composite — see §7) · Industry · Strength ≥ · Has open roles · Warmth · Stage · Owner · Reached-out-by · Flagged/Unflagged. Sort on any column.
- **Bulk bar** (on multi-select): **Flag for jobs activation** (pick owner + reason) · **Request intro** (pick the best-connected staffer → creates an `intro_request`) · Set stage · Unflag.
- **Account detail** gets a "Flag contacts" action mirroring the bulk flow.

---

## 6. Signals — all from existing tables (Phase A, no new pipelines)
| Signal | Source |
|---|---|
| Connection strength (+ best connector) | `staff_contact_relationships.relationship_strength` per contact + the staff name (coarse today; improvable later) |
| Company / industry fit | `public.companies.industry` via `contacts.company_id` (fallback: name match on `current_company`) |
| Open roles at company | count of `public.job_postings` at the contact's company (by `company_name`/`company_id`) |
| Warmth | derived from `bedrock.activity` (existing warmth helper) |
| Title / seniority | `contacts.current_title` |
| Staff disposition | `bedrock.connection_status` (per-staff "not a fit" etc.) |

---

## 7. "Viable only" = a saved filter, not a stored state
Default composite (tunable): `status active` AND `not already flagged` AND (`strength ≥ medium` OR `has open roles` OR `warmth ≥ warm`). Ships as a preset in the filter bar; nothing persisted on the contact.

---

## 8. Explicitly OUT of scope here (Phase B+)
Dropping `is_jobs_contact`; adding `contacts.status`; splitting `contact_stage`; the nightly-pipeline + `merge_contacts()` migration; `account.sf_id`/`name_key`; account dedupe execution; SF sync consolidation; staff-edge changes; person `party_id` unification. Each is a separate, deliberate step.

## 9. Build order
1. Migration: create `jobs_contact_membership` + indexes; backfill membership from `is_jobs_contact`/`contact_stage`.
2. Backend: the endpoints (flag/bulk-flag, membership PATCH/DELETE, account flag-contacts, request-intro) + `first_outreach_by` stamping on the `→initial_outreach` transition (from the intro_request connector or the outreach activity) + account-status signal + `GET /contacts` signal enrichment.
3. Frontend: contacts-page columns/filters/sort + bulk bar (flag / request-intro / set-stage / unflag) + account "flag contacts".
4. Nightly reconcile job (is_jobs_contact ⇒ membership).
5. Verify: flag a contact → funnel stage shows; request an intro → intro_request created for the connector; on outreach, `first_outreach_by` stamped; account flips to Activating; `handed_off` on opportunity create; `not_a_fit` off-ramp works; unflag reverses; existing metrics unchanged.
