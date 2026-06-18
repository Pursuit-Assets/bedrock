# Jobs pipeline — overnight work review

Branch: `feat/jobs-opp-tab`. Everything below is committed + locally tested unless
marked ⏸ (needs your approval). Local: backend `python3 main.py` (:8000),
frontend `npm run dev -- --port 4200`. Test in the **Opportunities** tab.

## ✅ Done earlier this session (deployed to prod)
- Gmail sync collision fix (sole Cloud Scheduler trigger) + full nightly relink.
- Global search now includes bedrock/jobs contacts (not just Salesforce).
- Phase 1 role model: commitment (committed/open-market), trial flag, trial→FT
  conversion link, rich comp fields. Migration applied. (frontend + backend, NOT
  yet deployed — pending your review.)

## ⏸ Parked for your approval
- **Retroactive role backfill** — 8 existing FT hires → filled roles. Script +
  exact list in chat; `scripts/backfill_jobs_activity_links.py` pattern. Run on OK.
- **Prod deploy** of the `feat/jobs-opp-tab` work (Opportunities tab + Phase 1).

## 🔨 Overnight — done, committed, locally tested (`feat/jobs-opp-tab`)
Each is `tsc`-clean + smoke-tested; no prod deploys (awaiting your review).

1. **Trial→FT conversion link** (`b35f6f8`) — Roles form shows a "Converts to" picker
   for trial roles; read view shows "→ converts to <FT role>".
2. **Closed-lost reason capture** (`e2d0ea5`) — moving a deal to Closed-Lost opens a
   modal for a structured reason + note (powers "why deals die" analysis).
3. **Opportunity stage cleanup** (`e2d0ea5`) — the opp stage picker drops Lead
   Submitted + Initial Outreach (prospect-level stages); legacy values still display.
4. **Opportunity meta fields** (`e2d0ea5`) — `priority` (1–5, validated), `segment`
   (VC/PE…), `intro_by` (warm-intro attribution), `closed_lost_reason/_note`.
   Migration `db/migrations/2026-06-17-jobs-opp-feedback.sql` (applied; bedrock_user-owned).
5. **Prioritization UI** (`abedde6`) — expanded-deal context strip edits priority /
   segment / warm-intro + shows closed-lost reason; a P# badge shows on each row.
6. **Auto-priority suggestion** (`b7cab4d`) — list computes `priority_suggested`
   (1–5) from signals (committed roles, multiple contacts, recent activity, builders
   applying); editor shows "suggest P# · use" when unset — one-click, overridable.

## 📋 Specced next (not yet built — safe, no approval needed)
- **Segment / priority filters** on the Opportunities toolbar (filter by VC/PE,
  focus high-priority). Contained client-side filter in JobsTeam.
- **Interview tracking** — per-role interview funnel (applied→round1/2/3→offer) +
  time-in-stage, building on `public.job_applications` (+ its `stage_history` jsonb).
- **Account→Opportunity conversion** + **surface builder activity on accounts**
  (account-centric view — build ADDITIVELY, don't replace current tabs).
- **Contact-resolver broadening** — link the email pull to all `public.contacts` by
  email (not just `is_jobs_contact`) so accounts/opps surface more contacts.
- **Insights (Phase 5)** — Fireflies summary type to auto-extract Damon's engagement
  fields + closed-lost reason; performance trends. (Bigger; scaffold/spec only.)

## ⏸ Still needs your approval (unchanged)
- Retroactive role backfill (8 FT hires → filled roles) — list approved in chat,
  awaiting go. Script: would mirror `scripts/backfill_jobs_activity_links.py`.
- **Prod deploy** of all the above (Opportunities tab + Phase 1 + this round).

## ✅ Smoke-test checklist (localhost:4200 → Opportunities)

**Opportunities list / row**
- [ ] Search box filters by company / role / owner.
- [ ] Filter pills work: Owner (Avni/Damon/Devika/All), Stage group (All/Active/On-hold/Closed), Deal Type (FT default).
- [ ] Column sort works: Company, Stage, Deal Type, Likelihood, **Priority**, # Roles.
- [ ] Inline-edit on the row saves + toasts: **Stage** (dropdown no longer offers Lead Submitted / Initial Outreach), **Deal Type**, **Likelihood**, **Priority** (P1–P5 colored badge), **Segment** (VC/PE…), **Role title**, **Expected salary**, **# Roles**, **Owner** (picker opens + stays open + saves).
- [ ] Calculated **Status** chip (Active/On-hold/Closed) tracks the stage.
- [ ] **Recent-activity** "N this wk" badge shows on accounts with activity ≤7 days.

**Stage-change modals**
- [ ] → **Closed-Lost** opens the reason modal (reason dropdown + note); saving shows the reason in the expanded context strip.
- [ ] → **Opportunity Confirmed** (first time, no roles) opens the committed-roles modal.
- [ ] → **Closed-Won** (FT/contract) opens the record-placements modal.

**Expanded row — tabs**
- [ ] Context strip: "Suggested priority P# · use" applies it to the row; **Warm intro by** edits; **Closed-lost reason** shows when closed-lost.
- [ ] **Activity**: Gmail/Calendar/Salesforce brand icons; **search by participant** (from/to/subject/body); Jobs vs Email&Calendar sections; expand a row → full email body, From/To; HTML entities decoded (no `&#39;`); log a call/text/LinkedIn.
- [ ] **Roles**: add a role with **Commitment** (Committed/Open-market), **Trial** checkbox → **Converts to** picker appears; comp fields (rate+period, end date, cadence, benefits, negotiation, JD link), notes; read view shows Open-market/Trial badges + "→ converts to <FT role>".
- [ ] **Builders**: link a builder; log an application/interview; change a status inline.
- [ ] **Contacts**: link a contact (search); edit a contact's stage inline; expand a contact → its activity.
- [ ] **Tasks** / **Comments** render and accept input.

**Performance tab**
- [ ] Opportunities **funnel** starts at "In Discussions" (no Lead Submitted / Initial Outreach).

**Global search (top bar)**
- [ ] Searching a jobs contact's name/email surfaces them (bedrock contacts, not just SF) → clicking deep-links to the Prospects tab with the search pre-filled.

**Backend / data (already verified by me, re-check if desired)**
- [ ] Invalid priority (>5) → 400; valid → 200.
- [ ] `committed_ft_roles` excludes open-market + trial roles.
- [ ] Gmail sync: tonight's 04:00 UTC run logs once (no collision); watermarks advance (check `bedrock.sync_watermark`).

## How to test locally
Backend `:8000` + frontend `:4200` running. Opportunities tab → expand a deal:
context strip (priority/segment/intro_by), Roles tab (commitment/trial/conversion/comp),
Builders, Contacts, Activity (icons + participant search). Move a deal to Closed-Lost
to see the reason modal. Stage dropdown no longer offers the first two stages.
