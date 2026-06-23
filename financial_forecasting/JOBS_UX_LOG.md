# Jobs pipeline — UX/UI improvement loop

Autonomous `/loop` (dynamic, self-paced) polishing the jobs section on
`feat/jobs-opp-tab`. Guardrails: jobs section only; additive/safe; verify
(`tsc --noEmit` + `vite build`) before each commit; commit + push; NO PRs, NO
prod deploy, NO destructive DB ops or privileged migrations.

## Iterations

1. **Accounts hub status chips** — REVERTED per user feedback ("look really bad,
   already have that in filtering"). Lesson: don't add net-new UI elements;
   focus on polishing/fixing EXISTING UI, not inventing redundant controls.
