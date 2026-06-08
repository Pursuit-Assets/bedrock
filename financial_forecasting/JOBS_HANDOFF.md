# Jobs Pipeline — Handoff to the Jobs Team

You own the **frontend and the pipeline-management UX** from here. This doc covers
everything you need to build against the data without needing to understand how
the data works internally.

**The one rule:** build against the **API endpoints** below. Never query or write
to `employment_records` / `job_applications` / `contacts` directly. The numbers on
the dashboard depend on reconciliation logic that lives *behind* the API — bypass
it and you'll silently get wrong counts.

Data questions → **[data owner / Jac]**. Schema/migration changes are not yours to
make; request them.

---

## 1. What this tool is

Three surfaces under `/jobs` (frontend `src/pages/Jobs.tsx`):
- **Performance** (default tab) — leadership metrics, funnels, placements
- **Deals** — day-to-day opportunity management (the kanban/list + expand panels)
- **Contacts** — employer-contact management

Backend lives in `financial_forecasting/routes/jobs.py` (+ `candidates.py`).

---

## 2. Data model — the 5 things, and what each means

| Concept | Table | Represents | Notes |
|---------|-------|-----------|-------|
| **Opportunity** (deal) | `bedrock.jobs_opportunity` | An employer relationship/deal moving through pipeline stages | Jobs-team only. Has `stage`, `deal_type`, `owner_email`, `sf_contact_ids[]`, `builder_ids[]` |
| **Prospect** (contact) | `public.contacts` (`is_jobs_contact=true`) | Employer contacts | SHARED table — only rows flagged `is_jobs_contact` are ours. `contact_stage` = lead/initial_outreach/active/on_hold |
| **Builder application** | `public.job_applications` (`source_type='Pursuit_referred'`) | The submission pipeline: applied → interview → accepted | SHARED table — 600+ rows are Pathfinder builder self-logs; only `Pursuit_referred` (~70) are ours |
| **Secured job / placement** | `public.employment_records` | **THE single source of truth for placements** | SHARED. `influenced` = jobs-team / self-sourced / null. `opportunity_id` links to the won deal |
| **Activity** | `bedrock.activity` (`jobs_opportunity_id` set, or `source='manual'`) | Emails/calls/meetings logged against deals | Gmail/Calendar sync also writes here |

### The two pipelines are different lenses — don't conflate them
- **`job_applications`** = the *submission funnel* (did we put a builder forward?).
- **`employment_records`** = the *outcome* (did a builder actually get a paid job?).
- A jobs-team FT hire appears in **both** (accepted application **and** an influenced FT employment_record). That's correct — it's the intersection, not a duplicate.

### Single-source decisions (do not re-derive these elsewhere)
- **"Placements" = PAID `employment_records`** (`payment_amount > 0`). Unpaid freelance / pro-bono do **not** count.
- **Placements are counted by DISTINCT BUILDER, not by job.** A builder with 2 PT roles = 1 placement. Two tracked numbers:
  - **Builders Placed FT** = distinct builders with any paid full-time record
  - **In any paid work** = distinct builders with any paid record
- **FT vs PT/Contract**: `employment_type='full_time'` → FT; `contract`/`freelance` → PT/Contract.
- **Influence**: a placement is "jobs-team influenced" if linked to a Pursuit-referred application or a won deal; otherwise self-sourced or (for historical rows) unclassified.
- **One deal → many placements** (`employment_records.opportunity_id`). JP Morgan = 1 deal, 3 builders hired.

---

## 3. API reference (the contract you build against)

All under `/api/jobs`. All require auth (bearer/cookie, already handled by the app's `api` client).

### Read / dashboard
| Endpoint | Returns |
|----------|---------|
| `GET /opportunities` | deal list (filter `stage`, `stage_group`, `owner_email`, `account_id`, `deal_type`) |
| `GET /opportunities/{id}` | one deal + stage history + activity + linked contacts |
| `GET /opportunities/pipeline` | stage counts + deal-type breakdown |
| `GET /funnel/{type}` | `type` = opportunities \| prospects \| builders — stages, counts, conversion, per-stage records + movement |
| `GET /roles` | jobs roles: hired_ft/hired_contract/committed + per-application rows (segments) |
| `GET /placements` | distinct-builder placement counts (ft_builders, any_builders, influenced_*) + rows |
| `GET /contacts/summary` | Prospects + Outreach metrics |
| `GET /contacts` | jobs contacts list (filter stage/company/search) |
| `GET /contacts/{id}` | contact detail + all activity (email/name matched) |
| `GET /contacts/search?q=` | search ALL 32k contacts (SF/LinkedIn/Airtable) for pickers |
| `GET /metrics/{key}` | generic drill-down: `{title, columns, rows, entity, child_columns}` — backs the MetricDrawer. keys: total_leads, engaged_leads, outreach_week, calls_total, calls_week, active_orgs, in_discussion, builder_interviews, placements, candidates_submitted, interviewing |
| `GET /staff?q=` | active Pursuit staff (owner picker) |
| `GET /builders?search=` | platform builders (builder picker) |
| `GET /placements/unlinked?q=` | employment_records not yet tied to a deal |
| `GET /opportunities/{id}/placements` | placements linked to a deal |

### Write
| Endpoint | Action |
|----------|--------|
| `POST /opportunities` | create deal |
| `PATCH /opportunities/{id}` | update any field; stage change auto-logs `jobs_stage_history` |
| `DELETE /opportunities/{id}` | soft-delete |
| `POST /contacts` | create contact |
| `PATCH /contacts/{id}` | update contact |
| `POST /contacts/{id}/add-to-jobs` / `DELETE …` | flag/unflag jobs contact |
| `POST /activity` | log email/call/meeting/note against a deal |
| `DELETE /activity/{id}` | soft-delete activity |
| `POST /opportunities/{id}/placements` | record a hire (creates employment_record, influenced=true). **Dedup-guarded**: enriches existing record if builder already placed at that company |
| `POST /opportunities/{id}/placements/{pid}/link` | link existing employment_record to a won deal |
| `PATCH /placements/{id}` | set influence attribution |

Drawer/expand patterns already built you can reuse: `MetricDrawer` (generic drill, supports inline-edit dropdowns for deal/contact and expandable rows for placements), `JobsFunnels` (3-funnel switcher with per-stage expand + movement).

---

## 4. Do / Don't

**DO**
- Consume the endpoints above. Add new endpoints by asking the data owner if you need data not exposed.
- Trust the counts the API returns (they're reconciled — distinct builders, paid-only, deduped).
- Reuse `MetricDrawer`, `JobsFunnels`, `StaffPicker`, the inline-edit patterns.

**DON'T**
- ❌ Write SQL or hit `employment_records` / `job_applications` / `contacts` directly.
- ❌ Re-implement "placements" / "hired" / "FT vs PT" counting in the frontend — use `/placements` and `/roles`.
- ❌ Re-run the one-time Airtable import scripts in `scripts/` (they're not idempotent — caused duplicates we cleaned up).
- ❌ Add/alter DB columns or the `bedrock.secured_jobs()` / `search_builders()` functions. These are load-bearing (they bypass RLS on `public.users`). Request schema changes from the data owner.

---

## 5. Known limitations / open data work (NOT your scope — data team)

- **Salesforce push** — placements live only in Bedrock; syncing them (and won deals → PBC Opportunities) to SF is **not built**. Tracked.
- **Funnel movement history** — only **Opportunities** has stage-change history (`jobs_stage_history`), and it's sparse (fills as the team moves deals in Bedrock). **Prospects/Builders** funnels show current-state only — the "movement" panels being empty is *expected*, not a frontend bug. Adding history capture for those is backend work.
- **Unclassified placements** — ~50 historical `employment_records` have `influenced = null`. Classifying them (influenced vs self-sourced) is data-entry via the existing inline UI — that part *is* fine for you to do.
- **Imports are done** — the Airtable migration (deals, contacts, applications, placements) is complete. Don't re-run.

---

## 6. Environment

- Backend: `financial_forecasting/main.py` (FastAPI, :8000). `./dev.sh` runs back+front.
- Frontend: `frontend-v2/` (Vite/React, :4200). `VITE_API_URL` → backend.
- DB: `segundo-db` (Cloud SQL). Your IP must be in the SQL instance's authorized networks to run a local backend. Migrations live in `db/migrations/` — the prod schema is reproducible from them (incl. `2026-06-08-jobs-pipeline-prod-schema-capture.sql`, which captures the jobs-pipeline columns + SECURITY DEFINER functions).
