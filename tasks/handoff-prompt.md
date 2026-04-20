# Fresh-shell handoff prompt — Bedrock MVP launch sprint

Open this file, copy the fenced prompt block, paste it into a new Claude Code shell. Gives the fresh session everything it needs to pick up the next bug cold without re-establishing context by trial and error.

**Current next bug:** B3 — Reports + Contacts tables cap at 500 rows.

**Launch target:** Wed 2026-04-22.

---

## Copy everything inside the block below

```
Continue the Bedrock MVP-launch bug sprint. Launch target: Wed 2026-04-22.

Before doing anything, read in this order:
1. tasks/mvp-launch-sprint.md — canonical bug spec (B1–B9 prioritized)
2. tasks/jac-running-notes.md — live status page; shows which bugs have shipped and which is next
3. tasks/notes-2026-04-17-jac-review.md — original session notes with the bug-symptom descriptions from JP + Jac's review

Task: the bug marked "🔜 Next" in tasks/jac-running-notes.md.
If that's B3 specifically: the transcript symptom is around lines ~34:29–35:13. "Reports" in the transcript means frontend/src/pages/Opportunities.tsx (renamed in PR #109).

Standing directives — non-negotiable. JP wants highest-standard, production-grade-secure work:
- Enter plan mode FIRST. Do at least 4 verification passes, each deeper than the last.
- Verify every claim against source before proposing a fix. No assumptions.
- Apply the feedback_highest_standard_security + feedback_production_discipline memories.
- Ask clarifying questions about scope or architectural choices before writing code.
- PR = "I tested this and it's good" per Jac's process feedback (not "I built this, help me test it").
- Bundle a tasks/jac-running-notes.md update (status-table row flip + progress-log entry at the top) into the same PR diff. No separate docs-update PRs.

Workflow:
- Cut a fresh branch from the latest origin/dev. Name convention: fix/b<N>-<brief-description> for bug fixes.
- Single coordinated PR targeting dev. Include verification results (test counts, typecheck status) in the PR body.
- Squash-merge on approval per feedback_prefer_prs.
- Do NOT touch open PRs from prior bugs that are still pending review.

Open PRs + pending hand-off items (as of the last sprint update — cross-check tasks/jac-running-notes.md for the current state):
- PR #142 (B1) merged. Pending Jac actions: run db/migrations/2026-04-19-add-manage-owner-goals-permission.sql against the shared segundo-db, and confirm the deployed backend .env has DATABASE_URL set (localhost fallback removed).
- PR #144 (B2) open, awaiting Jac's review.

Proceed with plan mode.
```

---

## Maintenance — update this file when a bug ships

When the current "next" bug is shipped and you're lining up the next one:

1. Update the **Current next bug** line at the top to the new bug ID + one-line label (e.g. `B4 — task create/edit/delete bugs`).
2. If the new bug has specific transcript-line references in `tasks/notes-2026-04-17-jac-review.md`, swap those into the prompt's "If that's B<N> specifically" line. Otherwise delete that line — the fresh session will find it via `tasks/jac-running-notes.md` and `tasks/mvp-launch-sprint.md` on its own.
3. Update the "Open PRs + pending hand-off items" section at the bottom of the prompt to reflect which PRs are currently open and which Jac action items are still outstanding.
4. Leave the rest (standing directives, workflow, format) stable — session-to-session consistency matters.

Bundle the edit with whichever bug-fix PR you're about to ship so there's no separate docs-churn PR for maintaining this file. Same pattern as `tasks/jac-running-notes.md`.
