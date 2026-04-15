# Bedrock & Pebble: What We Built and What It Does for You

*Bedrock organizes what you know. Pebble discovers what you don't.*

Version: 1.0 | Date: 2026-03-31 | Author: JP

A guide for the Pursuit fundraising team. No technical background required. Feedback welcome — this is a living document.

---

## Why This Exists

Right now, tracking Pursuit's fundraising pipeline means switching between Salesforce, spreadsheets, Slack, Google Calendar, and email — with no single place that shows the full picture. Assembling a pipeline status update takes an hour. Preparing for a funder meeting means 20 minutes of Googling. When someone asks "where does the money stand?" nobody has a fast answer.

Bedrock and Pebble exist to change that.

We're rolling this out in phases — starting with a small group to build confidence, collect feedback, and expand access as the team gets comfortable with core workflows.

---

## What These Tools Are

**Bedrock** is Pursuit's fundraising command center — every funder, opportunity, dollar, and deadline in one place. It connects to Salesforce so data entered once appears everywhere.

**Pebble** is an AI research assistant that lives inside Bedrock. Ask it a quick CRM question and get an instant answer, or give it a name and organization and it builds a sourced profile in under 30 seconds — pulling from public records, SEC filings, nonprofit databases, and news — so you walk into every meeting prepared.

Pebble is available to JP and Jac during Phase 1 for testing. Self-service access comes after cost guardrails are in place (see the [Addendum](ONBOARDING-ADDENDUM.md) for the timeline).

---

## Why a Phased Rollout

We could turn everything on for everyone on Day 1. We're choosing not to — and here's why.

**1. Prove it works before we depend on it.** "Working great in testing" isn't the same as consistently delivering accurate projections, clean data, and reliable workflows under real conditions. We need to see it perform against explicit metrics before expanding.

**2. Build trust through earned access.** Think of each feature like a new team member on probation — you don't hand them the full client list after one good week. You give them a defined scope, watch them perform, and expand based on demonstrated reliability.

**3. Measure before you declare success.** What does "working" mean? We've defined specific, measurable criteria for each phase (see the [Addendum](ONBOARDING-ADDENDUM.md) for the full metrics framework). No phase gate opens until the metrics say it's ready.

**4. Protect the data you're investing time to clean.** When Erica spends 20 minutes updating her top Opportunities, those records need to stay clean. Ownership controls ensure nobody accidentally edits someone else's carefully maintained records.

**5. One thing at a time, done right.** Overwhelming the team with every feature at once guarantees that nothing gets adopted well. Focused rollout means each workflow gets real attention and real feedback.

---

## Who Gets Access and What You Can Do

This is a phased rollout. Each role starts with the features most relevant to their work. Access expands only when explicit success criteria are met — not on a calendar.

### For Relationship Managers — Erica, Guilherme

RMs own and manage fundraising Opportunities. Your focus in Phase 1: clean up your top 20-30 Opportunities and build fluency with the Priorities and Pipeline pages.

| What you can do | Status |
| :---- | :---- |
| See your weekly priorities — deadlines, tasks, calendar, goal progress — in one view (filter by weighted or total) | Working today |
| Edit your own Opportunities — change stage, amount, close date — and it saves to Salesforce instantly | Working today |
| View the Dashboard to see pipeline health and cash flow projections (read-only) | Working today |
| Create and edit accounts and contacts for your pipeline | Working today |
| Create and complete tasks on your own Opportunities — assigned, dated, tracked — saves to Salesforce | Working today |
| Lock an Opportunity to protect it from accidental edits (unlock anytime) | Working today |
| Search for any record across the CRM (read-only access to others' Opportunities) | Working today |

**What you won't see yet:** Projects tab and Pebble are not in your view for Phase 1. These come later as we expand.

**Why these boundaries:** Your Opportunities are your territory. Clean, accurate data on the top 30-60 Opps is the #1 goal in Week 1. Nobody else edits your deals without your knowledge. We expand access as the team builds confidence in the core workflows.

#### Try these workflows

1. **Get oriented (5 min):** Log in → open **Priorities** → review your top Opportunities → click one and update its stage. Watch it save to Salesforce.

2. **Task sprint (20 min):** Open your top 20 Opportunities. For each one, create a Task with a due date — "Follow up with program officer," "Send budget revision," "Schedule site visit." Assign them to yourself or a colleague. Now check your **Priorities** page — every task you just created appears sorted by urgency.

3. **Pipeline cleanup (15 min):** Go to **Pipeline**. Sort by close date. Find Opportunities with dates in the past or stages that haven't changed in months. Update the ones you know about. Flag the ones you're unsure about — send JP a Slack message.

> **Coming soon:** Pebble auto-research to prep for funder meetings — walk in knowing the prospect's board seats, giving history, and wealth indicators without Googling. The manual 20-minute Google session becomes a 30-second Pebble query.

---

### For the CEO — Nick

As Executive, you see everything in the MVP page set except Pebble (JP and Jac are testing it). Your focus in Phase 1: evaluate executive visibility. Do the Dashboard numbers match your mental model? How do individual RM portfolios look?

| What you can do | Status |
| :---- | :---- |
| See total pipeline, weighted pipeline, cash flow by quarter, and a stage funnel — in seconds | Working today |
| Filter by team member to see who owns what — their portfolio, tasks, and deadlines | Working today |
| Review individual RM portfolios to assess pipeline health and workload balance | Working today |
| Project the Dashboard during your existing pipeline meeting (no new meeting needed) | Working today |
| Create and assign tasks to track team commitments | Working today |
| View and explore the Projects page for cross-functional visibility | Working today |

**What you won't see yet:** Pebble is restricted to JP and Jac during Phase 1. You cannot edit Opportunities directly — that's RM territory. Give feedback via tasks or verbally.

**Your job in beta:** Stress-test the Dashboard and projections. Do the numbers match your mental model? What's confusing? What's missing? Every piece of feedback shapes the next build.

#### Try these workflows

1. **Morning pipeline check (3 min):** Open **Dashboard**. Review the pipeline funnel — are the stage proportions what you'd expect? Check the cash flow projection — does the quarterly outlook match your assumptions?

2. **RM portfolio review (10 min):** On the Dashboard, filter by team member. Review Erica's portfolio — how many Opportunities does she own? What stages are they in? Are there stale deals? Do the same for Guilherme. Look at workload balance and suggest improvements to how revenue projections reflect reality.

3. **Pipeline meeting (30 min):** Project the Dashboard on screen during your next pipeline meeting. Walk through the funnel together. When someone commits to a follow-up, create a Task right there — assigned, dated, linked to the Opportunity. No more "I'll send that in an email."

> **Coming soon:** Pebble bulk research to assess prospect quality across the pipeline. Concentration risk alerts when too much revenue depends on one funder. AI portfolio recommendations: who should own which Opportunities, and why.

---

### For Project Managers — Laura, Johnny, Allie

PMs manage Projects (like AI Jobs Institute) and coordinate across the fundraising pipeline. You can see everything in the CRM (read-only) but can only edit within the Projects tab. Your focus in Phase 1: validate the project structure, link relevant Opportunities, and build out task timelines.

| What you can do | Status |
| :---- | :---- |
| Manage projects with Gantt charts, Kanban boards, milestones, and task dependencies | Working today |
| Search and view anything in the CRM — Opportunities, Accounts, Contacts (read-only) | Working today |
| Link Opportunities to Projects (e.g., connect grants to AI Jobs Institute) | Working today |
| Create Tasks on Projects with dependencies and timelines | Working today |
| View the Pipeline and Dashboard for context on fundraising status (read-only) | Working today |
| Request task additions on Opportunities you don't own (via Notifications) | Coming soon |

**What you can't do:** Directly edit Opportunities or their Tasks. If you need a Task added to an Opportunity you don't own, you'll submit a request — the Opportunity owner gets a notification and decides whether to accept. This keeps ownership clear and ensures the people accountable for Opportunities stay in control.

#### Try these workflows

1. **Review your project (10 min):** Open **Projects** → select AI Jobs Institute. Switch between Gantt, Kanban, and List views. Are the milestones right? Are dependencies correct? Create or adjust a Task if something's missing.

2. **Connect the pipeline (15 min):** Search for Opportunities related to your project. Link them — now you can see which grants fund which project work. Create project-level Tasks that depend on fundraising milestones (e.g., "Begin program design" depends on "Award letter received").

3. **Coordinate with an RM (coming soon):** You notice a grant tied to your project needs a budget revision Task. Instead of Slacking the RM, you'll click "Request Task" on their Opportunity, fill in the details, and they'll get a notification to accept or decline. Clean, tracked, no context lost.

> **Coming soon:** Complex dependency visualization in Gantt view — multi-predecessor chains, critical path highlighting. Project ownership model. Pebble quick CRM lookups to help find the right Opportunities to link.

---

### For Developers — JP, Jac

Full Admin access. Everything visible, everything editable — including Pebble research and chat. JP and Jac test new features before they roll out, maintain data quality, manage user profiles, and investigate bugs.

---

### For everyone

When you edit an opportunity or create a task in Bedrock, those changes save back to Salesforce. You're not maintaining two systems — Bedrock is your Salesforce interface, just simpler. Salesforce stays the system of record underneath.

This is a phased rollout — each profile starts with core features and we expand access as the team builds confidence. Your access is scoped to what you need right now. If something feels missing, tell JP — every feature request gets a timeline, never "maybe later."

---

## Pages at a Glance

| Page | URL | Who sees it | What it does |
|------|-----|-------------|--------------|
| **Priorities** | /priorities | Everyone | Your weekly command center — calendar, task inbox, top Opportunities ranked by value and urgency |
| **Dashboard** | /dashboard | Everyone | Revenue snapshot — total pipeline, weighted pipeline, quarterly projections, pipeline funnel |
| **Pipeline** | /pipeline | Everyone | Stage-based funnel of all Opportunities with filtering |
| **Projects** | /projects | Executive, PM, Dev | Workstreams, milestones, tasks — Gantt, Kanban, List, and Executive views |
| **Settings** | /settings | Everyone | Salesforce connection, Google account, profile settings |

---

## What Works Today vs. What's Coming

### Working Now

- Weekly priorities view (deadlines, tasks, calendar, goal tracker — filterable by team member)
- Opportunity pipeline (create, edit in-line, change stage — all changes save to Salesforce)
- Accounts and contacts (search, create — saves to Salesforce)
- Salesforce connection (reads your data automatically; your edits save back to Salesforce)
- Executive dashboard (pipeline funnel, cash flow projections, scenario analysis)
- Ownership visibility (every opportunity shows its owner; filter by team member)
- Task management (create, assign, complete — saves to Salesforce)
- Lead management (import CSV, track status and priority)
- Project management (Gantt, Kanban, List, and Executive views with task dependencies)
- Role-based permissions and navigation (each profile sees only the pages relevant to their role)
- Duplicate detection (automatic — when creating records through Pebble, it checks for existing matches and asks before creating duplicates; fiscal-year-aware for opportunity renewals)
- Pebble prospect research *(JP and Jac testing in Phase 1; team access after cost guardrails)*

### Coming Next

*(Built or being built — unlocked after MVP rollout)*

- PM task requests — Project Managers can request task additions on Opportunities they don't own, with owner approval via Notifications
- Automation Review (Slack messages → proposed CRM updates → approve or reject)
- Activity timeline (call, email, meeting history per contact in one view)
- Chrome extension (log emails and meetings from Gmail and Google Calendar)
- Stale deal flagging (auto-flag opportunities with no activity for 30+ days)
- Decision audit trail (record why you pursued or passed on a prospect)
- Grant requirements capture (reporting schedules, metrics, funder obligations)
- Ask Pebble — conversational CRM intelligence: instant lookups, tiered research (quick check → structured intel → full brief)

### On the Roadmap

*(Planned, 1-3 weeks out)*

- AI portfolio recommendations (who should own which opportunities, and why)
- Pebble bulk research (quick-check hundreds → deep-research the best fits → auto-categorize)
- Kanban drag-and-drop pipeline view
- Sage Intacct integration (invoice push, payment pull)
- Concentration risk alerts

---

## How Bedrock Fits With Your Current Tools

- **Salesforce:** Every edit in Bedrock saves to Salesforce immediately. You're not maintaining two systems. You can still open Salesforce anytime.
- **Sage Intacct:** Invoice matching and cashflow detail coming after initial rollout. Sage stays the accounting system of record.
- **Slack:** Coming soon — post pipeline updates in Slack and Bedrock captures them automatically, proposes the change, and waits for your approval.
- **Calendar & Fireflies:** Coming soon — meeting notes and activity history per account.

**What Bedrock replaces:** The spreadsheets. The tab-switching. The "ask someone who remembers" workflow.

**What Bedrock does NOT replace:** Email, your judgment about relationships, Salesforce (it's still underneath), Sage (still the financial system of record).

---

## Getting Started

### Pre-Launch

JP seeds Bedrock with your actual Salesforce data — you'll see real opportunities, not a demo. Each user is assigned a permission profile (Developer/Admin, Executive, Relationship Manager, or Project Manager) that determines which pages and features you see.

**Phase 1 participants:** JP and Jac (Developer/Admin), Nick (Executive), Erica and Guilherme (RM), Laura, Johnny, and Allie (PM).

### Phase 1 — Week 1: Explore and Break Things

Everyone: Log in, click everything, screenshot anything confusing and send to JP on Slack.

**RMs (Erica, Guilherme):**
- Open **Priorities**. Check your top Opportunities and tasks. Do the numbers match your mental model?
- Edit an Opportunity — update a stage, fix a close date. Watch it save.
- Create or complete a task in Bedrock instead of Salesforce.

**CEO (Nick):**
- Open **Dashboard** and **Priorities**. Do the pipeline numbers match your mental model?
- Filter by team member — how does each RM's portfolio look?
- Flag anything that seems off about the revenue or cash flow projections.

**PMs (Laura, Johnny, Allie):**
- Open **Projects**. Does the AI Jobs Institute structure make sense?
- Explore the Gantt, Kanban, and List views. Are milestones and dependencies correct?
- Browse the Pipeline and Dashboard (read-only) for context.

### Phase 1 — Week 2: Active Use

**RMs:** Use Bedrock as your primary pipeline view. Clean up stale Opportunities. Create Tasks instead of using Salesforce directly. Goal: your top 20-30 Opps are clean and current.

**CEO:** Run your next pipeline meeting from the Dashboard. Assign follow-up Tasks during the meeting.

**PMs:** Link Opportunities to your projects. Build out the project timeline with Tasks and dependencies.

**Everyone:** 15-minute check-in with JP. Walk through any "I expected X but got Y" moments. JP prioritizes fixes and feature requests from Week 1-2 feedback.

### Phase 1 — What "Success" Looks Like (Before We Expand)

Phase 2 access doesn't open on a calendar. It opens when these metrics are met:

| Who | Metric | Target |
| :--- | :--- | :--- |
| RMs | Top 30 Opportunities updated with accurate stages, amounts, and close dates | 100% of top 30 |
| RMs | Tasks created and tracked in Bedrock instead of Salesforce/spreadsheets | ≥ 5 tasks/week per RM |
| CEO | Pipeline meeting run from the Dashboard (not a spreadsheet) | ≥ 1 meeting |
| CEO | Cash flow projection reviewed and feedback submitted | Feedback received |
| PMs | AI Jobs Institute project structure validated in Projects | Structure confirmed |
| PMs | Opportunities linked to project | ≥ 3 linked |
| All | Bugs or confusion reported to JP | Every issue flagged, not worked around |
| All | Zero data quality regressions (no new duplicates, no stale records created) | 0 regressions |

*For the full metrics framework across all phases, see the [Addendum](ONBOARDING-ADDENDUM.md).*

### Phase 2: Expanding Access

Phase 1 metrics met → Phase 2 unlocks:

- PM task-request feature ships — PMs can request task additions on Opportunities via Notifications
- Pebble access expands beyond JP and Jac (after per-user cost controls are in place)
- Additional users onboarded as trust in core workflows is established

### Ongoing

- Keep using Bedrock as your primary pipeline view
- JP stays on Slack — every feature request gets a timeline, never "maybe later"
- Pebble self-service access once cost guardrails are ready

---

## What This Is NOT (Yet)

Being honest about where things stand builds trust faster than overpromising.

- This is a custom internal tool being actively developed. It will improve every week. Some edges will be rough.
- It won't send emails or schedule events. It tracks relationships, money, and decisions.
- It won't auto-generate outreach messages. Pebble provides intelligence; you write the message in your own voice.
- It won't let you edit someone else's Opportunities or Tasks unless your role allows it. This is by design — ownership sovereignty protects your records and keeps data clean.
- It's not replacing Salesforce. It makes Salesforce data useful by combining it with everything else.
- Pebble is in testing with JP and Jac only. Each research run uses paid AI services. Self-service access is coming once per-user cost controls are in place.
- There will be bugs. Reporting them to JP is helpful, not annoying.

---

## Where This Is Going

The near-term targets: Bedrock as the primary pipeline tool, at least one retired spreadsheet, and pipeline meetings run from the Dashboard.

**Coming over time:**

- Pebble evolves from single-contact research → conversational CRM intelligence → bulk research with auto-categorization → live assistant that recommends actions
- AI portfolio intelligence: who should own which opportunities, based on relationship history, workload, and funder fit
- Bedrock merges into Pursuit's unified AI-native learning platform — one login, one system

*For the full vision, Pebble architecture, permission details, progressive workflows, sprint plan, and the Opportunity stage glossary (what each stage means and how it maps to wins / losses / revenue), see the [Addendum](ONBOARDING-ADDENDUM.md).*
