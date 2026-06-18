# Jobs pipeline — UX/UI improvement loop

Autonomous `/loop` (dynamic, self-paced) polishing the jobs section on
`feat/jobs-opp-tab`. Guardrails: jobs section only; additive/safe; verify
(`tsc --noEmit` + `vite build`) before each commit; commit + push; NO PRs, NO
prod deploy, NO destructive DB ops or privileged migrations.

## Iterations

1. **Accounts hub status chips** — a status-distribution chip bar above the
   table (Pursuing / Stewarding / Re-activating / Prospect / Dormant with live
   counts). Click a chip to filter to that status (drives a `status` filter
   rule), click again to clear. Gives an at-a-glance pipeline read + one-click
   filtering. tsc + build clean.
