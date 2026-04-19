# Documentation Review (Updated 2026-03-19)

Original review: 2026-03-15 (19 findings + 4 contradictions across 27 files).
Updated: 2026-03-19 after CRM architecture docs, entity map, integration register, canonical definitions, and PRD index landed on main.

---

## Summary of Changes (2026-03-19)

- **2 findings dropped** — superseded by new docs (#4 home-page-spec, #6 phase numbering)
- **4 resolved** — #15 Salesforce spec, #18 dangling KG reference (fixed this commit), C1 team data sharing, C2 Slack timeline
- **15 items remain open** (13 numbered findings + C3, C4) — all updated with current state, gaps narrowed
- **#5 and #17 consolidated** — same underlying gap (prototype→production data migration)

---

## Open Findings (by priority)

### High

#### #2 — Open questions from `vision.md` remain partially unresolved

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Critical |
| **Current severity** | High |

**Original concern:** Six questions at the end of `vision.md` were unanswered, blocking the network search feature.

**Current state (2026-03-19):**
- Q1 (LinkedIn data format): **Answered** — LinkedIn contacts come from the learning platform's repository of team LinkedIn downloads. Field availability TBD pending platform integration.
- Q2 (External HNWI/prospect lists): **Answered** — Team has years of accumulated research in Excel and Google Sheets, some sourced from professional wealth screening tools. Pebble will need to ingest and normalize this semi-structured data.
- Q3 (Existing pipeline data): Deferred — Salesforce is active; spreadsheet data exists but migration path unspecified.
- Q4 (Are opportunity stages accurate?): Deferred — canonical stages now defined in `canonical-definitions.md` §1, but real-world calibration pending.
- Q5 (How many users?): Deferred — prototype is single-device; production user count unspecified.
- Q6 (Nick's prioritization criteria): Deferred — no documented criteria.

**Remaining gap:** Q1/Q2 answers are documented in conversation but not yet written into `vision.md` or a formal spec. Q3–Q6 remain unresolved. See also: `pebble-network-intro.md` (future feature spec) captures the LinkedIn/prospect list ingestion requirements.

**Recommendation:** Update `vision.md` with Q1/Q2 answers. Resolve Q3–Q6 before prospect intelligence (PRD #11) development begins.

---

#### #5 + #17 (Consolidated) — No prototype → production data migration plan

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Critical (#5) + Medium (#17) |
| **Current severity** | High |

**Original concern:** No migration path from Bedrock (localStorage) → Prospect Dashboard (IndexedDB) → production PostgreSQL. Real data could be lost.

**Current state (2026-03-19):**
- `entity-map.md` defines PostgreSQL-compatible schemas for all entities
- `canonical-definitions.md` establishes field naming and ID patterns that are consistent across storage layers
- `learning-platform-integration.md` describes the target PostgreSQL schema conventions
- Architecture is compatible — the gap is the **execution plan** for migration

**Remaining gap:** No documented procedure for exporting IndexedDB data and importing it into PostgreSQL. No data validation or transformation steps defined.

**Recommendation:** Document a migration runbook before the team loads significant real data into the prototype.

---

### Medium

#### #1 — Two apps with no merge plan

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Critical |
| **Current severity** | Medium |

**Original concern:** Bedrock (React + MUI/CRA) and Prospect Dashboard (Vite + Tailwind + shadcn) have no documented merge plan.

**Current state (2026-03-19):**
- `ROADMAP-AND-STANDARDS.md` clearly defines the destination: Bedrock lives in the learning platform eventually
- `learning-platform-integration.md` specifies the target stack (React 19 + Vite + Tailwind + shadcn, Node + Express, PostgreSQL)
- Phase roadmap: prototype in this repo → feature-complete here → merge into learning platform

**Remaining gap:** No transition timeline with milestones. "Medium term" and "Long term" phases don't have dates.

**Recommendation:** Add approximate dates or trigger conditions to the medium/long-term phases.

---

#### #3 — Network search scoring weights are uncalibrated

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Critical |
| **Current severity** | Medium |

**Original concern:** Composite score formula in `network-search.md` uses placeholder weights. Tiers (Hot/Warm/Worth Exploring) depend on untested thresholds.

**Current state (2026-03-19):**
- `entity-map.md` §11 explicitly defers composite_score and outreach_priority to post-MVP: "Do not implement these fields until composite_score calculation logic is documented and reviewed."
- MVP NetworkMatch schema is 4 fields only (id, linkedin_contact_id, prospect_contact_id, match_confidence)

**Remaining gap:** Weights and tier mappings still need calibration against real data.

**Recommendation:** Run a proof-of-concept with real prospect data before locking the scoring algorithm. This is a Phase 2+ task per entity-map.md.

---

#### #7 — `Activity` entity allows orphaned records

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Structural |
| **Current severity** | Medium |

**Original concern:** Activity has three optional parent references (`contact_id`, `opportunity_id`, `prospect_id`); all can be null simultaneously.

**Current state (2026-03-19):**
- `entity-map.md` §8 defines Activity with the same three optional references — no minimum-parent constraint added
- No documentation of multi-parent semantics (can an Activity link to both a Contact AND an Opportunity?)

**Recommendation:** Add a minimum-parent constraint (at least one must be non-null) to the data model. Document multi-parent semantics.

---

#### #8 — `Opportunity` supports only one contact

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Structural |
| **Current severity** | Medium |

**Original concern:** `primary_contact_id` is singular. Real fundraising involves coordinating with multiple people at an organization.

**Current state (2026-03-19):**
- `entity-map.md` §3 still uses `primary_contact_id: string → Contact`
- `canonical-definitions.md` §2 defines `primary_contact_id` as "The main contact on an Opportunity"
- Contact↔Account is many-to-many, but Opportunity→Contact remains singular

**Recommendation:** Consider a junction table or `secondary_contact_ids` array post-MVP. For MVP, the single contact is acceptable if the team understands the limitation.

---

#### #9 — `NetworkMatch` doesn't handle ambiguous matches

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Structural |
| **Current severity** | Medium |

**Original concern:** Fuzzy matching produces many-to-many ambiguities. NetworkMatch stores only one match per record.

**Current state (2026-03-19):**
- `entity-map.md` §11 defines MVP as a minimal 4-field schema; composite scoring deferred to post-MVP
- No match-candidates model or resolution workflow documented

**Recommendation:** Document the resolution workflow for ambiguous matches before post-MVP scoring is implemented.

---

#### #13 — Prototype security assumptions are vague

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Security |
| **Current severity** | Medium |

**Original concern:** "Pursuit-managed device" undefined, deployment audience unspecified, no sign-off.

**Current state (2026-03-19):**
- `security-requirements.md` has detailed security requirements (HTTPS, encryption at rest, PII handling, access logging)
- `ROADMAP-AND-STANDARDS.md` §Database security confirms: IndexedDB/in-memory is not production-grade; production requires PostgreSQL with proper backup/encryption
- Device scope and explicit sign-off still missing

**Remaining gap:** No formal definition of "Pursuit-managed device." No documented leadership sign-off.

**Recommendation:** Get written sign-off. Define device and audience scope.

---

#### #16 — No test strategy

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Missing docs |
| **Current severity** | Medium |

**Original concern:** No unit, integration, or E2E test plan. No sample CSV fixtures.

**Current state (2026-03-19):**
- `TEST-COVERAGE-ANALYSIS.md` was written and subsequently archived — no active replacement
- No current test strategy document in the product docs

**Recommendation:** Create a lightweight test strategy covering at minimum: smoke tests for CSV import, integration tests for Salesforce sync, and acceptance test scenarios per PRD.

---

#### C3 — Prospect list availability

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Contradiction |
| **Current severity** | Medium |

**Original concern:** `network-search.md` assumes prospect lists exist; `vision.md` open questions say lists not yet identified.

**Current state (2026-03-19):**
- JP answered: team has Excel and Google Sheets with years of accumulated prospect research, some from professional wealth screening tools
- Answer is documented in conversation and in `pebble-network-intro.md` (future feature spec) but not yet in `vision.md` or `network-search.md`

**Recommendation:** Update `vision.md` Q2 and `network-search.md` with the prospect list details.

---

### Low

#### #10 — `Lead` defined inconsistently across sources

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Structural |
| **Current severity** | Low |

**Original concern:** Four different definitions of "Lead" across docs.

**Current state (2026-03-19):**
- **Canonically resolved:** `entity-map.md` §6 renames Lead → **Prospect** for fundraising ("renamed to avoid confusion with learning platform")
- `canonical-definitions.md` §3 uses `prospect-{year}-{nnn}` IDs (not `lead-`)
- `learning-platform-integration.md` clearly distinguishes: learning platform `lead` = admissions; Bedrock "lead" = fundraising prospect
- Legacy files (`home-page-spec.md`, `knowledge-graph-compat.md`, `vision.md`, `data-model.md`) still use "Lead" terminology

**Remaining gap:** Legacy files not yet updated to use "Prospect" consistently.

**Recommendation:** Low priority — update legacy files to use "Prospect" as part of routine doc maintenance.

---

#### #11 — Sequential IDs assume a global counter

| Field | Value |
|-------|-------|
| **Status** | Open (acknowledged) |
| **Original severity** | Structural |
| **Current severity** | Low |

**Original concern:** `opp-2026-{nnn}` patterns have no collision prevention under concurrent use.

**Current state (2026-03-19):**
- `canonical-definitions.md` §3 acknowledges the issue: "Week-1 prototype exception: uses `prospect-{Date.now()}-{index}` for simplicity. Before production, migrate to sequential IDs with a server-side counter."
- This is a known prototype limitation, not an oversight.

**Recommendation:** Implement server-side counter when migrating to PostgreSQL. No action needed for prototype.

---

#### #12 — Payment schedule validation gap

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Structural |
| **Current severity** | Low |

**Original concern:** No validation rules for when a user manually edits one payment in a schedule (total vs. opportunity amount).

**Current state (2026-03-19):**
- `entity-map.md` §4 defines Payment entity but does not specify validation behavior for manual edits
- Payment is a post-MVP entity per PRD index (#04)

**Recommendation:** Define validation behavior (reject, warn, or auto-adjust) when Payment CRUD is implemented.

---

#### #14 — Claude API governance is undefined

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Security |
| **Current severity** | Low (partially addressed) |

**Original concern:** `home-page-spec.md §3.3` references "the org's Claude subscription" with no governance.

**Current state (2026-03-23):**
- `integration-register.md` §7 clarifies scope: "Pebble uses Claude; Bedrock does not call Claude directly for research."
- Pebble's architecture: Anthropic direct API + local Ollama. PII never through OpenRouter.
- Ask Pebble spec (`product/crm-prds/ask-pebble-spec.md`, 2026-03-23) now documents: tiered rate limiting (L0: 30/min, L1: 15/min, T1: 15/min, T2: 10/min, T3: 5/min), per-prospect budget cap ($0.50), progressive cost controls with human review gates, internal API key auth for CRM bridge, and JP-only access gate.

**Remaining gap:** Key rotation policy, cost monitoring dashboard, per-user daily/monthly budget caps, and alert thresholds are documented as requirements in the Ask Pebble spec's Governance section but not yet implemented. Target: before Sprint 3 self-service (Week 5-6).

**Recommendation:** Implement governance controls from Ask Pebble spec before Sprint 3 self-service rollout.

---

#### #19 — Speakerphone blocker for transcript pipeline

| Field | Value |
|-------|-------|
| **Status** | Open (unchanged) |
| **Original severity** | Missing docs |
| **Current severity** | Low |

**Original concern:** 9/10 Fireflies transcripts fail because the conference room doesn't route audio through Zoom. Speakerphone purchase needed but not tracked.

**Current state (2026-03-19):**
- Transcript pipeline is Phase 4+ per `ROADMAP-AND-STANDARDS.md`
- Hardware blocker still not tracked in any roadmap

**Recommendation:** Add speakerphone purchase as a tracked dependency when transcript pipeline moves to active development.

---

#### C4 — Lead storage contradiction

| Field | Value |
|-------|-------|
| **Status** | Updated |
| **Original severity** | Contradiction |
| **Current severity** | Low |

**Original concern:** Decision 6.3 says Salesforce Lead is system of record; Weeks 1–2 use localStorage with no Salesforce sync.

**Current state (2026-03-19):**
- `entity-map.md` §6 defines the migration path: Prototype (IndexedDB/in-memory) → Salesforce Lead with RecordType `Fundraising_Lead` → optional PostgreSQL `fundraising_prospect` table
- `integration-register.md` §1 documents Salesforce as the system of record with full field mappings
- Canonical authority is clear; the gap is the transition execution plan (overlaps with #5+#17)

**Recommendation:** Covered by #5+#17 consolidated recommendation — document the migration runbook.

---

## Resolved Findings

| # | Title | Resolution |
|---|-------|-----------|
| #15 | No Salesforce integration spec | **Resolved:** `integration-register.md` §1 provides full field mappings for Opportunity, Account, Contact, and Payment (NPSP). Direction, triggers, frequency, conflict resolution, and owner all documented. |
| #18 | Dangling KG reference | **Fixed:** Reference in `knowledge-graph-compat.md` replaced with deferred-initiative note (this commit). |
| C1 | Team data sharing contradiction | **Resolved:** `ROADMAP-AND-STANDARDS.md` and `learning-platform-integration.md` clarify: single-device prototype now, multi-user when merged with learning platform. |
| C2 | Slack timeline contradiction | **Resolved:** `ROADMAP-AND-STANDARDS.md` places Slack-driven pipeline updates in Short-term phase. Consistent with `slack-data-entry-and-review.md` spec. |

---

## Dropped Findings

| # | Title | Reason |
|---|-------|--------|
| #4 | `home-page-spec.md` severely out of scope | **Superseded:** `crm-prds/10-home.md` is a properly scoped PRD for the Unified Home Page — 14-day calendar view, tasks grouped by parent, top prospects, stale detection. The original `home-page-spec.md` is now a reference/phase document, not the active spec. |
| #6 | Phase numbering ambiguous | **Superseded:** `ROADMAP-AND-STANDARDS.md` provides a unified roadmap (Week 1 → Week 2 → Home → Short/Medium/Long term) with clear phase descriptions. `crm-prds/README.md` adds a PRD-level phase column (MVP vs. Post-MVP). |

---

## Updated Recommendations (priority-ordered)

| Priority | Action | Findings Addressed |
|----------|--------|--------------------|
| **High** | Document prototype→PostgreSQL migration runbook | #5, #17 |
| **High** | Update `vision.md` with Q1/Q2 answers; resolve Q3–Q6 | #2 |
| **Medium** | Add transition timeline/trigger conditions to ROADMAP phases | #1 |
| **Medium** | Add minimum-parent constraint to Activity entity | #7 |
| **Medium** | Document ambiguous match resolution workflow | #9 |
| **Medium** | Create lightweight test strategy | #16 |
| **Medium** | Get written security sign-off; define device scope | #13 |
| **Medium** | Update `vision.md` Q2 and `network-search.md` with prospect list details | C3 |
| **Low** | Update legacy files from "Lead" to "Prospect" | #10 |
| **Low** | Document Pebble API governance | #14 |
| **Low** | Track speakerphone purchase when transcript pipeline activates | #19 |
| **Low** | Define payment validation behavior when PRD #04 is built | #12 |
| **Deferred** | Calibrate network search weights with real data (Phase 2+) | #3 |
| **Deferred** | Add secondary contacts on Opportunity (post-MVP) | #8 |
| **Deferred** | Implement server-side ID counter (PostgreSQL migration) | #11 |

---

## Files Reviewed

Original review (2026-03-15) covered 27 files. Updated review (2026-03-19) additionally references the following new files that landed on main since March 15:

**New architecture docs (Phase 6 deliverables):**
- `product/crm-architecture/canonical-definitions.md` — stages, field names, IDs, enums (this file governs)
- `product/crm-architecture/entity-map.md` — full entity definitions, relationships, design decisions
- `product/crm-architecture/integration-register.md` — all 9 external integrations with field mappings

**New PRDs:**
- `product/crm-prds/README.md` — PRD index with 14 components, template, cross-references
- `product/crm-prds/10-home.md` — Unified Home Page PRD (supersedes finding #4)
- `product/crm-prds/03-pipeline.md` — Opportunity Management PRD
- `product/crm-prds/pebble-network-intro.md` — Future feature spec (new, this commit)

**Original files reviewed (2026-03-15):**
- `CLAUDE.md`
- `PRD.md`
- `product/overview.md`
- `product/ROADMAP-AND-STANDARDS.md`
- `product/REQUIREMENTS-GAPS-AND-STRUCTURE.md`
- `product/learning-platform-integration.md`
- `product/fundraising-team/vision.md`
- `product/fundraising-team/phases/README.md`
- `product/fundraising-team/phases/week-1-prototype.md`
- `product/fundraising-team/phases/week-2-pipeline-dashboard-network.md`
- `product/fundraising-team/phases/home-page-spec.md`
- `product/fundraising-team/phases/custom-reports.md`
- `product/fundraising-team/phases/slack-data-entry-and-review.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/vision.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/CLAUDE.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/specs/opportunity-pipeline.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/specs/leads-tracker.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/specs/network-search.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/specs/calendar-tasks.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/specs/transcript-pipeline.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/architecture/data-model.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/architecture/security-requirements.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/architecture/knowledge-graph-compat.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/architecture/transcript-reliability.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/decisions/2026-03-13-react-vite-stack.md`
- `product/fundraising-team/raw-prds/prospect-dashboard/decisions/2026-03-13-indexeddb-for-prototype.md`
