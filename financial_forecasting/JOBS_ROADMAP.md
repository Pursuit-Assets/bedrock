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
1. **Quick wins (no new data)** — A, B1, B2, F1. ✅ DONE (commits 0f47a00 backend, 7759ff2 frontend; F1 pre-existing). Not yet deployed.
2. **Work queues** — B3, D.
3. **Outreach analytics** — B4.
4. **Full universe** — C, H1/H2, LinkedIn mapping. *Blocked on user files.*
5. **Sputnik merge** — E.
