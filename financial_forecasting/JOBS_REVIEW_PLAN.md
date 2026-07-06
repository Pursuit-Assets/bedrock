# Jobs Build — Review Plan (2026-07-06)

From the "Jobs Build review" session (Jac, Joanna, Damon) — verified against the
recording (screen-share frames) and Jac's live notes doc "20260626 Jobs tooling
and processes". Screen attributions below are confirmed from video unless marked
(transcript-only). P0 = data integrity / trust, P1 = core workflow, P2 = enhancement.

## P0 — Data integrity & trust
1. **Outreach metrics polluted** — out-of-office auto-replies and non-jobs
   program email (PBD) count as jobs outreach. *Screen: Performance → Outreach
   & Activation drill (per-person dropdown).* Add jobs-relevance detection:
   short-term exclude auto-replies + subject/keyword rules; longer-term content
   read. Notes doc: "take out any non jobs related outreach (ex. Remove PBD)".
2. **Split team vs staff views** — Outreach & Activation should default to the
   core team only. Notes doc verbatim: "Remove everyone except Damon, Avni,
   Devika". Separate, more-intelligent view for staff mobilization.
3. **Fellows / alumni / current builders must auto-link out of the candidate
   queue** — exact-unique name match to SF fellow/alumni + builder roster at
   pipeline time so they never enter review. *Screen: Candidates.* (builder
   auto-absorb exists but too narrow; widen + run before queueing.)
4. **Acture role-title bug / possible double count** — Robert Petillo shows "IT
   Helpdesk Technician" but real role is "Junior Network Systems Engineer";
   stale, suspected Pathfinder-vs-Bedrock dual source. *Screens: Opportunities
   detail + Builders detail (transcript); FT Roles Secured drill shows him FT
   placed.* Trace role source of truth, fix stale title, rule out double-count.
5. **Fowler placement inconsistency** — Home says "no placement"; account/FT-
   Roles-Secured shows it as Committed (open req) / AI Builder with Ethan in a
   trial. Reconcile display across Home / Accounts / drill.
6. **Duplicates in Accounts** — Acture's account showed duplicate roles/opps;
   "so many duplicates" on the committed list. *Screen: Accounts.* De-dupe.
7. **Staff-name cleanup** — VISUALLY CONFIRMED dupes ("Greg Hogue" ×2,
   "Guilherme Barros" ×2 in the person dropdown) + people who've left. Dedupe +
   prune roster (feeds owner filter, My Network, Outreach dropdown).

## P1 — Placement / role status model (stakeholder vocabulary locked in notes doc)
8. **Trials not placed until conversion.** Model trial→FT as a trial role
   (committed) + a separate FT role (committed/open) so numbers never walk back.
   Retro-apply: JP Morgan (3), Fowler (Ethan), Jacob/Kelvin/Ariel.
9. **Sub-stages within Committed** (notes doc exact): **"Committed: no
   placement"** (signed, nobody sourced — Citizens Bank ×5, US Chamber) and
   **"Committed: trial active"** (someone in a trial — Fowler, JPM). Then
   **Full-time placed**. Role form already has a Committed/Trial/work-trial
   toggle to build on.
10. **Internal vs external reporting** — external: committed+placed together;
    internal: separate so placements get celebrated.

## P1 — Opportunity / role / builder modeling
11. **Opportunity = the ongoing conversation** (holds multiple roles); name it
    freely (e.g. "Spring 2026 discussion" — seen on screen), not after one role.
12. **Builders tie to roles, not opportunities** — hire/interview picker says
    "pick opportunity" → should be "pick role". *Screen: Accounts → expanded →
    Roles tab add-role/hire flow.*
13. **Stage-change prompts role creation** at the right point.

## P1 — Pathfinder ↔ Bedrock
14. **Roles created in Bedrock sync to Pathfinder + a visible visibility
    toggle** (notes doc: "Adding roles to bedrock: should have a visible
    toggle") so builders see them without manual re-add.
15. **Slack job-sourcing** — staff flag jobs across channels; auto-scrape +
    enrich (do we know anyone there / fit) → Pathfinder. Extends the undeployed
    LinkedIn job-scraper MVP. (Notes doc: "can staff still add jobs".)

## P1 — Candidate triage & outreach capture
16. **More candidate filters** — isolate unknown Gmail people; largely resolved
    once #3 auto-links the knowns out. (Search bar already shipped.)
17. **Capture all staff outreach in one place** — verify email actually flows
    in (inconsistent per notes); bulk-add texts / L0 / Damon's outreach-skill
    logs; define the manual-add process for non-email.

## P2 — Analytics & tooling
18. **Longitudinal metrics** — week-over-week / arbitrary ranges, timestamped.
19. **CSV export** of any view.
20. **Daily top-of-funnel view** (notes doc: "Add daily view").
21. **"Whole universe of leads" view** incl. migrated Sputnik leads (notes doc).
22. **Bedrock ↔ Claude MCP** — expand table access / new MCP so Claude can read
    AND update the main dataset (needs Carlos).
23. **Jobs/roles → Salesforce sync** — notes doc: "Jobs still need to be
    manually added into Salesforce".

## P2 — Stability & polish
24. **Accounts tab froze Damon's (HP) machine** — swap saturation / Chrome
    renderer; likely fixed by post-merge frontend redeploy; verify with logs.
25. **Post-create flow polish**; My Network intro requests (works; future:
    request a specific email + auto-verify sent; bulk).

## Sequencing
P0 #1–3 first (make numbers + queue trustworthy) → placement/role model #8–13 as
one chunk → Pathfinder #14–15 → analytics/tooling. Daily working sessions with
Damon this week.
