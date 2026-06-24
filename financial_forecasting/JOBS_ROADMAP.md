# Jobs pipeline — feedback round (Jackson Heights session)

Discrete features from the feedback transcript, phased. `feat/jobs-opp-tab`.

## Features
- **A. "Activated" account status** — derived third state between Prospect (untouched) and Pursuing (active opp): a prospect WITH outreach/activity but NO opportunity.
- **B1. Time filters** — accounts+contacts by last-activity window (past week/month); "newly activated this week/month".
- **B2. Team-member filter** — see/filter outreach by who did it.
- **B3. Work queues** — Leads (accounts w/o opp, prioritized — Friday) + Priorities (pursuing — Tuesday).
- **B4. Outreach chart drill** — filter by % + click into the actual email list.
- **C. Full-universe import** — ~30k SF accounts/contacts as untouched Prospects + relationship tags (past hiring partner, PBC, in-staff-LinkedIn-network) as filterable signals.
- **D. Assignable tasks + "My Tasks"**, auto-populated from follow-up dates.
- **E. Sputnik merge** — staff outreach logging into Bedrock, tagged to jobs.
- **F1. Jobs touches vs other Pursuit activity** — split history on account/contact (avoid double-outreach).
- **F2. Promote-to-PBC behavior** — DECISION: **keep stewarding in Bedrock** (account stays tracked, flagged PBC; no auto-close).
- **G. Owner-unassign bug** — ✅ DONE (commit 53fdcb6).
- **G2.** User will send a list of other small bugs.
- **H1/H2.** Pending user files: SF spreadsheets (still-at-org filtered) + volunteer master list (outreach flag).

## Phases
1. **Quick wins (no new data)** — A (renamed Activating), B1 (recency dropdown), B2 (folded into +Filter), F1. ✅ DONE. Plus **# Hired** column (builders + SF fellows via affiliations, name-bridged). Not yet deployed.
2. **Command center** — **D ✅ DONE v1** (commits 65a53a8 backend `tasks/all`+`interview-pipeline`, 193ec5b frontend `JobsHome.tsx` = new default Home tab: tasks board w/ My/assignee filter + create/assign/complete, builders-in-interviews tracker, new-activity/stale triage, KPIs). **B3 — SKIPPED** (user does on frontend). **F2 — SKIPPED for now.**
3. **Outreach analytics** — **B4** = make the ActivityTrends chart click-into-a-bar → activity list, + a real email viewer (not snippets). PENDING. Open Q for user: "filter by percent" = % split bars, or threshold filter? (asked, not answered)
4. **Full universe** — C, H1/H2, LinkedIn mapping. *Blocked on user files.* SKIP for now.
5. **Sputnik merge** — E. SKIP for now.

Not deployed yet (whole branch feat/jobs-opp-tab). Browser/Playwright was locked all session → no visual QA; verified via tsc+build+live API.
