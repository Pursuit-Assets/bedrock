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

## 🔨 Overnight (this doc updates as I go)
(see commits on the branch)
