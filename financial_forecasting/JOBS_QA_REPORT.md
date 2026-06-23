# Jobs Pipeline — QA / performance / data-quality audit (2026-06-18)

Scope: jobs backend (`routes/jobs.py`, `jobs_tasks.py`, `jobs_comments.py`, `services/gmail_sync.py`),
jobs frontend (`frontend-v2/src/pages/jobs`, `components/jobs`, services), and the live segundo-db data.
Method: 2 code reviewers (read-only) + direct DB/perf checks. Frontend `tsc --noEmit` clean.
Good news up front: **no SQL injection, no critical bugs, 0 orphan contact refs, 0 duplicate emails,
0 remaining activity dup-clusters, type-clean.**

Tags: [P]erf · [D]ata · [B]ackend · [F]rontend.

## HIGH
- **[P1] `/contacts` ≈ 4.0s.** `WHERE is_jobs_contact=true OR EXISTS(... sf_contact_ids ...)` defeats the
  index and evaluates the EXISTS over ~33k contacts (1.74s alone); connected-staff + 90-day-activity
  batch queries stack to ~4s. Fires on every Contacts-tab open (`limit=500`). Fix: UNION the indexed
  `is_jobs_contact` branch with the link branch; backfill `is_jobs_contact` for opp-linked contacts;
  paginate. Pairs with F2/F4 below.
- **[D1] Duplicate opportunities.** `Adonis AI` ×2 and `Con Ed` ×2 (each = an old `on_hold_not_responsive`
  + a newer active one, both carrying contacts). Same pattern as Citizens Bank (already fixed). Needs a
  careful MERGE (both sides hold data), not a blind delete.
- **[B] Unguarded `UUID()`/`int()`/`date.fromisoformat()` → 500 instead of 400.** Pervasive in
  jobs_tasks/comments create/patch/delete and several jobs.py spots. Worst: `_resolve_contacts`
  (`jobs.py:2265`) does `int(ref[4:])` over `sf_contact_ids` — one malformed `pub:` ref 500s the entire
  `GET /opportunities/{id}`. Fix: wrap parses → `HTTPException(400)`; skip non-numeric pub refs.
- **[B] `GET /accounts` fetches ALL opps + ALL jobs-contacts every call** (no LIMIT/pagination; deal_type
  filter applied in Python after fetch). Fine at 108 opps; grows linearly forever.
- **[F1] Over-broad cache invalidation.** 13 mutations call `invalidateQueries(["jobs"])`, marking the
  whole section stale (accounts, 500-row contacts, funnels, rollups) → refetch storm on any single edit.
  This amplifies P1. Fix: invalidate the specific sub-key only (the hooks already do that alongside the
  broad call — just drop the `["jobs"]` line).
- **[F3] No error states anywhere** in the jobs UI (`isError` used nowhere). A failed fetch silently
  renders an empty table or a misleading "not found". Fix: handle `isError` with a retry distinct from empty.
- **[B] Task PATCH doesn't validate `parent_type`** (`jobs_tasks.py` update) and the account mirror table
  has no CHECK — an arbitrary `parent_type` string can be written. Fix: validate on update; forbid changing it.
- **[SECURITY — confirm] `require_auth` is authentication-only, no role check.** Every jobs API route is
  reachable by any authenticated user (incl. non-staff). If jobs is staff-only, the API is an authZ gap
  even if the route is gated client-side. Confirm intent; add a role guard if needed.

## MEDIUM
- **[P2] Account Activity payload ≈ 1.9 MB** (`/account-activity` returns 250 rows incl. full
  `email_body_text`). Sent on every account → Activity tab. Fix: return snippets; lazy-load bodies on expand.
- **[B/D] `account_status` recency uses opp/prospect `updated_at`, not real activity.** The 90-day
  "Re-activating vs Dormant" split ignores `bedrock.activity` touches, so a recently-emailed account with
  stale opp rows can read Dormant — contradicts the intent. Fix: factor last activity_date in.
- **[B] `job_search_status` (builders) not validated** against `BUILDER_STATUSES` — any string persists and
  drives the board UI.
- **[B] `get_contact` activity:** `LIMIT 100` then dead `[:150]` slice; `sort(key=... or "")` mixes
  datetime with `""` → `TypeError` if any `activity_date` is NULL (currently 0 such rows → latent).
- **[B] gmail sync dedup race + date fallback.** Cross-mailbox dedup is a non-unique SELECT-then-INSERT
  (two concurrent syncs can both pass); date-parse `except → now()` silently corrupts `activity_date`
  (skews first-touch metrics).
- **[F2] No virtualization** (dependency present, unused): Contacts (500 rows), Opportunities (500),
  Accounts — all render every row into a plain table.
- **[F4] Search fires a query per keystroke** (Contacts find-any + builder/role pickers); no debounce.
- **[D2] Data-entry gaps:** 91/108 opps have `account_id='UNKNOWN'` (can't link to SF/portfolio accounts —
  blocks the unified-account view); 20 opps no owner; 6 no deal_type; 258 jobs-contacts no email.
  (Most already on the "send to team" list.)
- **[F-M1] Account row identity** mixes display name (key/expansion/toggle) and `account_key` (links/rollups)
  — name collisions/changes desync expansion from the detail page. Use `account_key` uniformly.
- **[F-M2] `useUpdateBuilderActivity("")`** called with empty oppId in accountTabs; works only via the broad
  `["jobs"]` invalidation (H1).

## LOW
- **[F] Dead files:** `pages/jobs/JobsAccounts.tsx`, `JobsAirtable.tsx`, `JobsSputnik.tsx`,
  `components/jobs/JobsAccountExpandPanel.tsx`, `FellowAvatar.tsx`, and the unused `ProspectAccountExpandPanel`
  panel (only its `ContactDetail`/`initials` exports are used). Delete or mark parked.
- **[F] Duplicate logic:** `CONTACT_STAGE_STYLES`/`initials` defined 3× (ProspectAccountExpandPanel,
  jobsEntity, JobsContacts). Hoist to one module.
- **[F] a11y:** icon-only buttons missing `aria-label` (open/delete opp, LinkedIn, expand). JobsTasks /
  RowExpandPanel do it right — match them.
- **[F] Hardcoded "32k+ contacts" copy** in JobsTeam search placeholders.
- **[B] Inconsistency:** comments hard-delete vs tasks soft-delete; `account_comments` rollup has no LIMIT;
  dead `ENGAGED` const; `JOBS_TEAM_EMAILS` duplicated across two files (drift risk).
- **[P4] No functional index on `lower(account_name)`** (negligible at 108 rows; revisit at scale).
- **[P] `is_jobs_contact` unindexed** (8ms today — low, but the OR-EXISTS in P1 is the real cost).
