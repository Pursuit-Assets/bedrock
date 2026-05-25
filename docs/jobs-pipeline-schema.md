# Fellow Job Pursuit pipeline — Salesforce schema design

**Status:** DRAFT — awaiting sign-off from Avni, Damon, Devika
**Author:** drafted 2026-05-12 by the Bedrock team, grounded in the
"Pursuit Jobs Team Playbook" (updated 2026-05-07).
**Purpose:** Specify the Salesforce data model so the Jobs team can move
off Airtable as their primary CRM and run their pipeline natively in
Salesforce (surfaced through Bedrock). Sign-off here unblocks the
migration build and the Pathfinder → SF sync.

---

## Why this exists

The jobs pipeline (employer outreach → builder placement) lives in
Airtable today. The playbook's plan is to move it to Salesforce or
Sputnik. This doc picks Salesforce, defines the schema, and gives the
Jobs team a single artifact to review before any data moves.

Goals the schema must support:

- **80% placement of L3+ cohort by July 2026** — 20+ placements, currently 8.
- **Weekly waterfall metrics**: 50-100 initial outreach, 25-30 active orgs, 2-3 builder interviews/week.
- **Conversion-rate tracking** at each stage transition (e.g. outreach → call: 20-25%).
- **Salary targets** ($85k+ avg across interviewed / committed / placed roles).
- **Cycle-time visibility** (4-8 weeks per Active org).
- **3-touch outreach rhythm** with structured cadence (Day 1 / 3-7 / 14 / 21).
- **Re-engage-later dates** with warmth-based defaults (1mo / 1q / 1yr).
- **Multi-source attribution** (Pursuit staff network, board, alumni, past hiring partners, etc.).
- **Builder-side linkage** — when a Builder applies via Pathfinder, the application links back to the Pursuit-side opp.

---

## Decision 1: Salesforce Opportunity (with new RecordType), NOT a new custom object

**Choice:** Add a new RecordType `Fellow_Job_Pursuit` to the standard
`Opportunity` object. Do not create a custom `Job_Pursuit__c` object.

**Why:**

- The existing PBC (Pursuit Builder Cohort) pipeline already lives on
  `Opportunity` with its own RecordType — same workflow shape (outreach
  → discussion → contract). Reusing the pattern means **Bedrock's
  Pipeline page, forecasting tooling, owner reporting, and stage
  history already work** for the new RecordType with zero extra plumbing.
- Salesforce's Opportunity has built-in `OwnerId`, `Amount`,
  `CloseDate`, `StageName`, stage history tracking (CloseDate + StageName
  changes are auto-logged on `OpportunityHistory`), and activity timeline
  (`Tasks` / `Events`). All needed.
- Corporate-partner overlap (Devika's case: one Account = philanthropy
  + job pursuit) is cleanly modeled as two Opps on the same Account
  with different RecordTypes — already how PBC + Philanthropy
  co-exist today.
- New custom objects require fresh metadata, new permission sets, new
  page layouts, and a custom UI. Avoidable.

**Trade-off accepted:** Some Opportunity-specific concepts (e.g.
`Probability` as a weighted-pipeline lever) don't map perfectly to a
job-pursuit workflow. We handle that by setting probability defaults
per stage (table below) and treating `Amount` as the salary proxy.

---

## Decision 2: Outreach touches as `Task` records, not opportunity fields

**Choice:** Each touch (email, LinkedIn DM, text) is one `Task` record
linked to the Opportunity (`WhatId = Opp.Id`) with structured fields:
`Touch_Number__c` (1, 2, 3), `Channel__c` (Email / LinkedIn / Text /
Call), `Touch_Type__c` (Initial / Follow-up / Final / Response /
Discovery-call-followup), `ActivityDate`, `Status` (Completed / Waiting
on response / No response).

**Why:**

- Aligns with playbook's "every single touchpoint will be tracked in
  the system of record".
- 3-touch cadence becomes queryable: `COUNT(Tasks WHERE Opp = X AND
  Touch_Type__c = 'Follow-up')`.
- Conversion-rate metrics roll up from Task counts, not free-text notes.
- Native SF Task UI works; Bedrock's existing Activity tab works.

---

## Decision 3: Pre-existing Affiliation is the placement record

**Choice:** Keep the existing `npe5__Affiliation__c` with
`Account_ForFellowsOnly__c` lookup as the **placement** record (the
`FellowsHired__r` related list we already render on the Jobs page).
A `Closed - Won/FT` opportunity should create or be linked to one
Affiliation per placed fellow.

**Why:**

- The Affiliation object already works in production and ties Fellow
  Contact → Account with role + start date + status.
- Avoids a parallel "placement" data structure.

**New field on Affiliation (one addition):** `Job_Pursuit_Opp__c`
(Lookup → Opportunity) to record which Opp produced this placement.
Enables: "show me every placement that came out of this outreach".

---

## The RecordType: `Fellow_Job_Pursuit`

### Stage picklist (replaces Airtable Job Deal stages)

Built from the playbook's pipeline-stages section. Probability defaults
align with the playbook waterfall (25% → 40% → 20% conversion).

| # | Stage (SF `StageName`) | Probability default | Open/Closed | Maps to Airtable Job Deal stage(s) |
|---|---|---|---|---|
| 1 | Lead Submitted | 5% | Open | (new — Airtable used R+D pre-contact) |
| 2 | Initial Outreach | 10% | Open | Reached Out |
| 3 | Active: In Discussions | 25% | Open | In Discussion |
| 4 | Active: Opportunity Confirmed | 50% | Open | In Contract, Active: Builder Matching |
| 5 | Active: Builder Interview | 75% | Open | Candidates Submitted, Interviewing, Active: Builder Interviews |
| 6 | Closed - Won / FT | 100% | Closed-Won | Closed - Won/FTE |
| 7 | Closed - Won / PT or Contract | 100% | Closed-Won | Closed - Won/Contract |
| 8 | Closed - Won / Capstone | 100% | Closed-Won | Closed - Won/Capstone or Volunteer (Capstone half) |
| 9 | Closed - Won / Volunteer | 100% | Closed-Won | Closed - Won/Capstone or Volunteer (Volunteer half) |
| 10 | On Hold: Not Selected | 0% | Closed-Lost | (new — was free text) |
| 11 | On Hold: Not Interested Right Now | 0% | Closed-Lost | (new) |
| 12 | On Hold: Not Responsive | 0% | Closed-Lost | (new — implied after 3 touches) |
| 13 | Closed - Lost | 0% | Closed-Lost | Closed - Lost |

**Notes:**
- The 4 Closed-Won stages mirror the playbook's "Capstone / Volunteer / PT-Contract / FT" outcomes; separating them in SF lets metrics roll up cleanly.
- The 3 "On Hold" stages are reusable — when a re-engagement date hits, the rep can re-open the Opp by moving it back to Initial Outreach.
- "Closed - Lost" is reserved for cases that don't fit "On Hold" (e.g. company shut down).

### Field map (Opportunity fields)

Stars (★) = new custom fields to add; everything else uses standard SF
fields or already exists.

| SF field | Type | Source (Airtable Job Deal) | Notes |
|---|---|---|---|
| `Name` | Text(255) | `Deal ID` formula | Auto-format: "{Account} — {Deal Type}" if free-text isn't entered. |
| `AccountId` | Lookup(Account) | `Company` (linked record) | Resolved via Bedrock identity layer during migration. |
| `OwnerId` | Lookup(User) | `Pursuit Deal Lead` | Mapped via name → SF user. |
| `StageName` | Picklist | `Deal Stage` | See stage map above. |
| `Amount` | Currency | (new — was implicit) | **Annualized salary** for the role. Target $85k+. |
| `CloseDate` | Date | (new — Airtable lacked this) | Required by SF. Use expected hire date; default to outreach-date + 60 days for Initial Outreach. |
| `Probability` | Percent | (auto-set by stage) | Derived from `StageName` per table above. |
| `RecordTypeId` | RecordType | n/a | `Fellow_Job_Pursuit`. |
| `Description` | Long text | `Notes` | Multiline. |
| `Next_Step__c` (standard `NextStep`) | Text(255) | `Next Step` | Standard field. |
| ★ `Deal_Types__c` | Multi-select picklist | `Deal Type` (multi-select) | Values: `Job: Existing FTE`, `Job: New FTE`, `Job: PT/Contract`, `Workshop`, `Capstone`, `Pilot`, `TBD`. |
| ★ `Lead_Source_Bucket__c` | Picklist | (new — from playbook) | Required. Values: `Pursuit Staff Network`, `Reactive (Job Posting)`, `Corporate Partner (Devika)`, `Board Members`, `Past Pursuit Staff`, `Past Commit Partners`, `Past Hiring Partners`, `Past Bash Attendees`, `Past Fellows`, `Past Volunteers`, `Project-based Partners`, `Other`. |
| ★ `Lead_Source_Detail__c` | Text(255) | (new — from playbook) | Free-text qualifier (e.g. "Damon's LinkedIn — Cam Hass"). |
| ★ `Primary_Contact__c` | Lookup(Contact) | `Deal Co' Contact` | Resolved via identity layer. SF Opps can have multiple contacts via OpportunityContactRole — this is the headline one. |
| ★ `On_Hold_Reengage_Date__c` | Date | (new — from playbook) | When a deal moves to any On Hold stage, the rep sets this. Owner-discretion: warm → 1mo, mild → 1q, cold → 1yr. |
| ★ `Touch_Count__c` | Roll-up Summary (count of `Task` records WHERE `Touch_Type__c` is set) | (auto) | For pipeline metrics. |
| ★ `Last_Touch_Date__c` | Roll-up Summary (max of Task ActivityDate) | (auto) | For "needs follow-up" filtering. |
| ★ `Last_Touch_Channel__c` | Formula or Apex trigger | (derived) | Used in cadence dashboards. |

### Field map (Task fields — touch tracking)

Standard `Task` + a few customs. Logged automatically by the Claude
skill described in the playbook ("logged with a Claude skill") and
by Bedrock when reps action follow-ups inside Bedrock.

| SF Task field | Type | Notes |
|---|---|---|
| `WhatId` | (polymorphic) | Always points to the Opportunity. |
| `WhoId` | Lookup(Contact) | The contact reached out to. |
| `OwnerId` | Lookup(User) | Rep who made the touch. |
| `Subject` | Text | "Initial outreach", "Follow-up 1", "Discovery call", etc. |
| `Status` | Picklist | `Sent` / `Replied` / `No response` / `Completed`. |
| `ActivityDate` | Date | When the touch happened or is scheduled. |
| ★ `Touch_Number__c` | Number | 1, 2, 3, 4. Counts only outreach touches, not call follow-ups. |
| ★ `Channel__c` | Picklist | `Email`, `LinkedIn`, `Text`, `Call`, `In-person`. |
| ★ `Touch_Type__c` | Picklist | `Initial`, `Follow-up`, `Final`, `Reply`, `Discovery call`, `Discovery call follow-up`, `Other`. |

### Field map (Affiliation — placement)

The single addition we discussed in Decision 3:

| SF field | Type | Notes |
|---|---|---|
| ★ `Job_Pursuit_Opp__c` | Lookup(Opportunity) | The Closed-Won opp that produced this placement. Populated at the time the opp is closed-won or shortly after. |

---

## Builder-side linkage (Pathfinder → SF)

The playbook describes Builders logging job applications in Pathfinder
(segundo-db is SoR). We're NOT rewiring Pathfinder in this phase; we
add a Bedrock sync that mirrors builder applications into SF as
`Fellow_Job_Application__c` (a custom object that already exists in
your org per our describe scan).

**Linkage rules:**
- The `Fellow_Job_Application__c` gets a Lookup(Opportunity) field
  pointing at the related Fellow_Job_Pursuit opp **if** one exists on
  the same Account; otherwise null. The Bedrock sync matches by Account
  + applied-role (best-effort).
- Multiple builders can apply against one opp (one Opp → many
  Applications).
- When a Closed-Won/FT happens, the rep marks the winning Application
  on the opp; the Affiliation record is auto-created from there.

(Detailed builder-side schema gets its own follow-up doc once the
pipeline migration lands. This doc focuses on the pursuit side.)

---

## Migration plan (one-time)

1. **Identity backbone** lands first (separate work stream; ~2 weeks):
   `bedrock.contact_link` + extended `bedrock.sf_account_company_map`,
   scoped to records referenced by Airtable Job Deals.
2. **Dry-run migration tool** (1 week): walks every Airtable Job Deal,
   resolves Company + Contact via the link table, would-create an SF
   Opp. Outputs an audit report — no writes. Outcomes team eyeballs the
   audit for ~50 random samples.
3. **Live migration** (1 day): same tool, but with writes enabled.
   Creates Opps with RecordType `Fellow_Job_Pursuit`. Backfills Touch
   tasks where Airtable Emp. Engagements link to a Job Deal.
4. **Airtable cutover**: Job Deals table → read-only archive. Keep for
   posterity, not deleted.

---

## Reporting (what this schema enables)

All metrics in the playbook's Dashboard section roll up natively from
SF reports / Bedrock pipeline page:

- **Weekly initial outreach** — `COUNT(Tasks WHERE Touch_Number__c = 1
  AND CreatedDate THIS WEEK)`.
- **Outreach-to-call conversion** — `COUNT(Stages = 'Active: In
  Discussions') / COUNT(Stages >= 'Initial Outreach')` cohort-windowed.
- **Active orgs** — `COUNT(Opportunity WHERE StageName LIKE 'Active%')`.
- **Builder interviews/week** — `COUNT(Stages = 'Active: Builder
  Interview' transitions this week)` from `OpportunityHistory`.
- **Avg salary placed** — `AVG(Amount) WHERE StageName = 'Closed - Won
  / FT'`.

These all run as standard SF reports today and will surface inside
Bedrock's existing pipeline + dashboard pages.

---

## Open questions for sign-off

1. **Closed-Won granularity**: separate stages for Capstone / Volunteer
   / PT-Contract / FT (my proposal), or one Closed-Won + a Deal_Type__c
   field on close? Separate stages are simpler to chart; single stage
   is cleaner if you'd rather not enumerate.
2. **Salary on non-FT stages**: do we still want `Amount` populated for
   PT/Contract and Capstone closes? If yes, annualize how? (Capstones
   are short engagements — Amount = total fee?)
3. **Owner model**: at Initial Outreach, who's owner — the rep
   reaching out, or the original lead source (e.g. the staff member who
   contributed the contact from their LinkedIn)? Playbook reads like
   "owner = active rep" but worth confirming.
4. **Corporate-partner crossover**: if Devika is engaging a corporate
   partner on both philanthropy AND jobs, do we want one combined Opp,
   two separate Opps (one per RecordType), or a flag on the Job Pursuit
   Opp pointing to the related Philanthropy Opp? My recommendation:
   two separate Opps with a "Related Opportunity" lookup between them.
5. **Re-engage automation**: when `On_Hold_Reengage_Date__c` hits, do
   we want SF to auto-create a follow-up Task, or send a Slack ping to
   the owner? (Both are easy; pick one for v1.)
6. **Touch SLAs / reminders**: should overdue follow-ups (Day-7-but-no-
   Touch-2) trigger a Bedrock notification?
7. **Pathfinder builder apps not tied to a pursuit**: if a Builder
   applies on their own to a company we haven't outreached to yet, do
   we auto-create a Fellow_Job_Pursuit opp in `Lead Submitted` stage?
   (My take: yes — closes a useful loop.)

---

## Out of scope for v1 (explicit deferral)

- Volunteer-side automation (currently ad-hoc per the playbook — VolunteerHub SOP TBD).
- Reporting requirements tracking (funder / apprenticeship reporting) — Kirstie's post-placement SOP.
- Career-coach AI assistance for builders (An's tool — separate effort).
- Auto-creating SF Contact records from staff_contact_relationships at scale (separate "staff network roll-up" phase).

---

## Sign-off

Please mark ✅ or ❌ + comments next to each:

- [ ] Avni (Jobs team lead, Outcomes)
- [ ] Damon (Outreach, Outcomes)
- [ ] Devika (Corporate partner, PBC overlap)
- [ ] Nick (RM leadership)
- [ ] Stef (Builder prep / matching)

Once we have ≥ 3 ✅'s, the migration build starts.
