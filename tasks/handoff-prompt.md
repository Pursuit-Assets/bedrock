# Fresh-shell handoff prompt — Bedrock MVP objects plan

Open this file, copy the fenced prompt block, paste it into a new Claude Code shell. Gives the fresh session everything it needs to pick up the next PR cold without re-establishing context by trial and error.

**Current next PR:** PR #148 — `pr-page-rename-cleanup` (first code PR after #147 planning doc merges; renames `MyDashboard.tsx` → `Priorities.tsx` and `Overview.tsx` → `Progress.tsx` to align files with sidebar labels before any larger code work touches them).

**Master plan:** `tasks/objects-production-readiness-plan.md` (23-PR sequence #147-#169).

---

## Copy everything inside the block below

```
Continue the Bedrock MVP objects production-readiness plan.

Before doing anything, read in this order:
1. tasks/objects-production-readiness-plan.md — master plan with full PR sequence (#147-#169), verified backend/frontend inventory, and per-PR scope detail
2. tasks/jac-running-notes.md — high-level rollup + pending Jac actions. Scope expansion recap at the top.
3. tasks/mvp-launch-sprint.md — original B1-B9 spec (B3, B6 absorbed into the plan; B4 split into PRs #161-#165; B5, B7-B9 become PRs #166-#169)

Task: the lowest-numbered PR in the plan's "PR sequence" table whose status is still ⏳ Queued. Start there.
- Verify the predicted PR number against the current gh PR counter: run `gh pr list --state all --limit 1 --json number`. If the next number isn't the one in the plan, the sequence has drifted — update the plan's PR-sequence table as part of your PR diff, then proceed.

Standing directives — non-negotiable. JP wants highest-standard, production-grade-secure work:
- Enter plan mode FIRST. Do at least 4 verification passes, each deeper than the last.
- Verify every claim against source before proposing a fix. No assumptions.
- Apply the feedback_highest_standard_security + feedback_production_discipline memories.
- Ask clarifying questions about scope or architectural choices before writing code.
- PR = "I tested this and it's good" per Jac's process feedback (not "I built this, help me test it").
- Bundle the doc updates (plan's PR-sequence status flip to 👀/✅, jac-running-notes.md progress-log entry at the top) into the same PR diff. No separate docs-update PRs.

Workflow:
- Cut a fresh branch from latest origin/dev. Name: <type>/pr<NNN>-<slug>, e.g. chore/pr148-page-rename-cleanup or fix/pr149-contacts-accounts-pagination.
- Execute the PR's scope exactly as specified in the plan. Do not bundle with other PR scopes.
- Single coordinated PR targeting dev. Include verification results (test counts, typecheck status) in the PR body.
- Squash-merge on JP approval per feedback_prefer_prs.
- Do NOT touch open PRs from prior entries in the plan that are still pending review.
- If the PR turns out larger than its "Size" column in the plan (S ≤200 LOC, M 200-500, L 500-1000), split before review and update the plan table.

Open PRs + pending hand-off items (⚠️ stale as of the last plan update — cross-check tasks/jac-running-notes.md and `gh pr list --state all --limit 5` before trusting, and fold corrections into your PR's bundled docs update):
- PR #142 (B1) merged. Pending Jac actions: run db/migrations/2026-04-19-add-manage-owner-goals-permission.sql against the shared segundo-db, and confirm the deployed backend .env has DATABASE_URL set (localhost fallback removed).
- PR #144 (B2) merged 2026-04-20.
- PR #146 (FRONTEND_URL default :4000 → :3000) merged 2026-04-20. Heads-up for Jac: if her local frontend runs on :4000, she needs FRONTEND_URL=http://localhost:4000 in her backend .env (DEV_SETUP_GUIDE.md documents this).
- PR #147 (this plan) — status depends on when you read this. Check jac-running-notes.md.

Proceed with plan mode.
```

---

## Maintenance — update this file when a PR ships

When the current next PR is shipped and you're lining up the next one:

1. Update the **Current next PR** line at the top to the next queued entry from `tasks/objects-production-readiness-plan.md`'s PR-sequence table.
2. Update the "Open PRs + pending hand-off items" section at the bottom to reflect which PRs are currently open, merged, or have outstanding Jac action items.
3. Leave the rest (standing directives, workflow, format) stable — session-to-session consistency matters.

Bundle the edit with whichever PR you're about to ship so there's no separate docs-churn PR for maintaining this file. Same pattern as `tasks/jac-running-notes.md` and the plan doc's PR-sequence table.
