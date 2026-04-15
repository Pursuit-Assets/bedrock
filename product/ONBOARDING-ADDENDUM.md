# Onboarding Addendum: Workflows, Permissions & Roadmap

> Companion to [ONBOARDINGPRD.md](ONBOARDINGPRD.md). Not required for onboarding — read this when you want to go deeper.

---

## A. Permission Profiles — Full Detail

### The 4 Beta Profiles

Bedrock uses permission profiles to control what each person sees and can do. During the beta rollout, we're deploying four profiles designed for a phased, trust-building launch.

| Profile | Who | Pages Visible | Core Access | Key Restrictions |
|---------|-----|---------------|-------------|------------------|
| **Developer/Admin** | JP, Jac | All pages | Full access — edit everything, Pebble research + chat, user management | None — full system access |
| **Executive** | Nick | Priorities, Dashboard, Pipeline, Projects, Settings | View everything, create & assign tasks | No Opp editing, no Pebble |
| **Relationship Manager** | Erica, Guilherme | Priorities, Dashboard, Pipeline, Settings | Edit own Opportunities + Tasks, create accounts & contacts | No Projects, no Pebble, no others' Opps |
| **Project Manager** | Laura, Johnny, Allie | Priorities, Dashboard, Pipeline, Projects, Settings | Full Project editing, link Opps to Projects, search full CRM | No Opp editing, no direct SF task creation on Opps. Task Requests planned (see Section F) |

### What Each Profile Can Touch

This matrix shows exactly what each role can do with each type of CRM object.

| Object | Action | RM | Executive | PM | Dev/Admin |
|--------|--------|:--:|:---------:|:--:|:--------:|
| **Opportunities** | View all | Yes | Yes | Yes | Yes |
| | Edit own | Yes | No | No | Yes |
| | Edit others' | No | No | No | Yes |
| | Create | No | No | No | Yes |
| | Lock own | Yes | No | No | Yes |
| | Reassign | No | No | No | Yes |
| **Salesforce Tasks** | View | Yes | Yes | Yes | Yes |
| | Edit own | Yes | Yes | No | Yes |
| | Create | Yes | Yes | No | Yes |
| **Projects** | View | No | Yes | Yes | Yes |
| | Create/Edit | No | No | Yes | Yes |
| | Delete | No | No | Yes | Yes |
| | Link Opps | No | No | Yes | Yes |
| **Project Tasks** | Create/Edit | No | No | Yes | Yes |
| **Accounts** | View | Yes | Yes | Yes | Yes |
| | Create/Edit | Yes | No | No | Yes |
| **Contacts** | View | Yes | Yes | Yes | Yes |
| | Create/Edit | Yes | No | No | Yes |
| **Dashboard** | View revenue | Yes | Yes | Yes | Yes |
| | View cash flow | Yes | Yes | Yes | Yes |
| **Pebble** | Chat | No | No | No | Yes |
| | Research | No | No | No | Yes |
| **Task Requests** | Create | No | No | Planned | Yes |
| | Approve/Reject | Planned | No | No | Yes |

### Pebble Access During Beta

- **Who can use Pebble now:** JP and Jac (Developer/Admin profile) — full access to Pebble chat and research
- **Why it's gated:** Each research run costs money (paid AI services). We need to prove the cost guardrails work before opening access
- **Budget per prospect:** ~$0.50 today; per-user daily and monthly caps are planned
- **When it opens up:** After the team is comfortable with core Bedrock workflows and cost controls are validated
- **What it costs you:** Nothing — the team doesn't see a bill. JP monitors usage and budget internally

### Why Phased Permissions

This isn't about trust in people — it's about trust in software. Rolling out to 4 users with focused permissions means:

1. **Clean data first.** RMs own their Opportunities. Nobody else edits your deals without your knowledge. This ensures the top 30-60 Opps get accurate stages, amounts, and close dates in Week 1 — which makes every projection and dashboard downstream reliable.

2. **Fewer moving parts.** Eight users across four profiles. If something goes wrong, we know exactly who touched what. Debugging is fast, fixes are targeted.

3. **Expanding is easy.** Once core workflows are proven, we add permissions — never take them away. Future phases: RMs get read-only Projects access, PMs get Opp coordination via Task Requests, everyone gets Pebble research.

---

## B. Progressive Workflows by Role

Each role has a set of workflows that build in complexity. Start at Level 1 on Day 1 and work your way up over the first week. Don't skip levels — each one builds the habits and data quality that the next level depends on.

### Relationship Manager Workflows

#### Level 1: Get Oriented (Day 1)

Your goal: confirm that your Opportunities look right and that edits save correctly.

1. Log in and go to the **Priorities** page — your top Opportunities should appear, ranked by financial impact
2. Click into one of your Opportunities — verify the stage, amount, and close date are correct
3. Make one edit: change a stage to something more accurate → confirm it saved by checking Salesforce
4. Create one task on that Opportunity: give it a specific subject ("Follow up on Q2 proposal"), a due date, and a description
5. Go back to the task inbox on Priorities — your new task should appear under "This Week" if the due date is within 7 days
6. Screenshot anything that looks wrong, confusing, or doesn't match Salesforce → Slack it to JP

#### Level 2: Task Discipline (Days 2-3)

Your goal: build the habit of task-driven pipeline management.

1. Pick your top 10 Opportunities (the ones with the most revenue at stake)
2. For each Opp, create at least one task with:
   - A specific, actionable subject (not "follow up" — try "Send revised budget to Sarah by Thursday")
   - A realistic due date
   - A brief description if the subject isn't self-explanatory
3. Use the task inbox on Priorities to see everything that's due this week
4. Complete a task when you've done the work — it disappears from the inbox and saves to Salesforce
5. Notice the urgency alerts on the Priorities table: amber chips mean something is overdue, green means a deal is approaching close, blue means something needs attention

#### Level 3: Portfolio Hygiene (Week 1)

Your goal: make every important Opportunity accurate so projections and dashboards are trustworthy.

1. Work through your top 20 Opportunities — this is the core of Bedrock's value
2. For each one:
   - **Stage:** Is it really at this stage, or has it moved forward/backward? Update it.
   - **Amount:** Is the estimated amount still realistic? Update if the scope changed.
   - **Close date:** Is this still the expected close? Push it out if it's unrealistic — an honest date is better than an optimistic one.
   - **Tasks:** Does this Opp have at least one active task? If not, create one — every deal needs a next action.
3. Flag stale Opportunities (the blue "Stale" chip appears after 30+ days of no activity):
   - Update the Opp if you have new information
   - If it's genuinely stalled, consider whether the stage should change
4. Lock any Opportunity you want to protect from accidental edits (you can unlock it anytime)
5. After your top 20 are clean, the Dashboard and Pipeline views become reliable — projections are only as good as the data behind them

> **Where Pebble takes this (coming soon):**
> Today you spend 20 minutes Googling a funder before a meeting. When Pebble opens up for the team, you'll type a name and get a sourced research brief in 30 seconds — SEC filings, nonprofit databases, political contributions, news — so you walk in prepared. The manual research session becomes a 30-second query. Eventually Pebble will auto-flag stale Opps and suggest follow-up actions based on what it knows about the funder — like "This foundation's fiscal year ends in June; they typically make grants in Q1. Your proposal should go out by April."

---

### CEO Workflows

#### Level 1: Dashboard Orientation (Day 1)

Your goal: confirm that the Dashboard matches your mental model of the pipeline.

1. Open the **Dashboard** — the hero card shows total pipeline and weighted pipeline
2. Check the quarterly breakdown — do the Q1-Q4 numbers feel right?
3. Switch between "Total" and "Weighted" views on the Priorities table — weighted adjusts by probability (a $100K deal at 50% counts as $50K)
4. Filter by team member — does each person's portfolio split make sense? Is the distribution what you expect?
5. Open **Pipeline** — the funnel shows how many Opportunities are at each stage. Are the distributions realistic? Too many stuck at "Identified" with nothing moving to "Proposal Sent"?
6. Note anything that doesn't match your expectations — this is the feedback that shapes the next build

#### Level 2: Pipeline Meeting Integration (Days 2-3)

Your goal: run your existing pipeline meeting from Bedrock instead of spreadsheets.

1. Project the **Dashboard** during your pipeline meeting — total pipeline, weighted pipeline, funnel, quarterly breakdown are all visible
2. Switch to **Priorities** — filter by each RM to review their top Opportunities
3. During the meeting, as commitments are made:
   - Create a task for each commitment: "Erica will send revised proposal to Ford Foundation by Friday"
   - Assign the task to the responsible RM with a due date
   - The RM will see it in their task inbox immediately
4. After the meeting: everyone's next actions are documented, dated, and tracked — no follow-up email needed

#### Level 3: Strategic Oversight (Week 1)

Your goal: use the Dashboard for strategic pipeline decisions, not just status updates.

1. Review cash flow projections by quarter — are we on track for annual targets?
2. Look for concentration risk — is too much of the pipeline tied to one funder or one revenue stream?
3. Check for stale Opportunities across the team — which deals haven't moved in 30+ days? Why?
4. Compare RM portfolios:
   - Who has the most Opportunities? Who has the highest weighted value?
   - Is anyone overloaded while someone else has capacity?
   - Are stage distributions healthy, or is one RM stuck at early stages?
5. Open **Projects** — see how grant Opportunities connect to AI Jobs Institute work. Are the most critical grants progressing?
6. Create tasks for strategic actions: "Schedule quarterly funder review with Guilherme" or "Research three new foundation prospects for Q3"

> **Where Pebble takes this (coming soon):**
> Eventually Pebble will provide portfolio intelligence: "Move Opp X from Erica to Guilherme — she's at capacity and he has sector alignment with this funder." The manual portfolio review becomes AI-assisted rebalancing. Pebble analyzes relationship history, sector expertise, workload balance, pipeline composition, and funder preferences to recommend optimal assignments.

---

### Project Manager Workflows

#### Level 1: Project Structure (Day 1)

Your goal: confirm that the Projects page accurately represents your work.

1. Open **Projects** and navigate to AI Jobs Institute (or another active project)
2. Switch between the four views to find what works best for you:
   - **List:** Hierarchical tree — workstreams, milestones, tasks nested underneath
   - **Kanban:** Cards grouped by status — drag to reorder
   - **Gantt:** Timeline with bars showing start/end dates — great for spotting scheduling conflicts
   - **Executive:** High-level summary — quick overview for leadership conversations
3. Check that workstreams, milestones, and tasks match your mental model of the project
4. Try creating a test task with a deadline to confirm the workflow

#### Level 2: Opportunity Linking (Days 2-3)

Your goal: connect CRM pipeline data to project plans.

1. Open the **Pipeline** page and search for a grant Opportunity related to AI Jobs Institute
2. Go to **Projects** → AI Jobs Institute → click "Link Opportunity"
3. Search for and select the Opportunity
4. Check the executive view — linked Opportunities should appear, showing pipeline stage and amount
5. Understand the connection: when an RM updates the Opportunity stage or amount in the CRM, it automatically reflects in your project view. You don't need to track funding status separately.

#### Level 3: Full Project Management (Week 1)

Your goal: make Projects your central tool for tracking deliverables and timelines.

1. Organize milestones with realistic start dates and deadlines
2. Assign project tasks to team members with clear ownership
3. Use the Gantt view to:
   - Visualize the full timeline
   - Spot tasks that overlap or conflict
   - Identify milestones that are at risk due to predecessor delays
4. If you have existing project plans in spreadsheets, use CSV import to bulk-load workstreams, milestones, and tasks — Bedrock matches by name and merges intelligently
5. Set up workstreams to group related milestones logically (e.g., "Grant Applications," "Program Design," "Reporting")

#### Level 4: Cross-Team Coordination (Week 2+, after Task Request ships)

Your goal: coordinate with RMs without violating their Opportunity ownership.

1. While reviewing a project, identify a task that needs to happen on an RM's Opportunity (e.g., "Erica needs to submit the Robin Hood progress report by April 15")
2. Click "Request Task on Opportunity" — available from the Projects page, Pipeline, or anywhere you see an Opportunity
3. Fill in:
   - Which Opportunity the task belongs to
   - Task subject and description
   - Proposed due date
4. The Opportunity owner (Erica in this case) receives a notification
5. She reviews the request and either:
   - **Accepts** — a real Salesforce Task is created on her Opportunity
   - **Rejects** — with an optional reason (e.g., "Already handling this differently")
6. You see the status update in your outgoing requests list
7. This pattern keeps RMs in control of their Opportunities while enabling cross-team coordination

> **Where Pebble takes this (coming soon):**
> Pebble bulk research will let you upload 100 prospect names, run quick identity checks on all of them, select who's worth a deeper look, and auto-categorize the best fits — renewal candidates, warm intro opportunities, insufficient giving capacity, cold prospects. Grant prospect research that took weeks becomes a morning's work.

> **Coming soon for Projects:**
> Complex dependencies in Gantt view — multi-predecessor chains, critical path highlighting. Project ownership model — define who can edit and delete each project. CSV export. These features make the Projects page a full-featured PM tool on par with dedicated project management software.

---

## C. Two Revenue Streams

Pursuit raises money through two distinct channels with different rules:

**Nonprofit grants** — Longer timelines, milestone-based payments, reporting requirements, restricted funding. Examples: Robin Hood Foundation, NYC Economic Development Corporation.

**PBC contracts** — Corporate partnerships, apprenticeship agreements, sponsorships. Invoice-on-delivery or net-30/60 terms. Examples: Google.org, JPMorgan Chase.

Both flow through the same pipeline stages in Bedrock, but every opportunity is tagged with its revenue stream so reporting can split or combine them. The executive dashboard already shows revenue by stream. When grant requirements capture launches, it will add reporting schedules and funder obligations specifically for nonprofit grants.

A single organization can have both a grant and a contract — the system handles this naturally.

*You don't need to do anything special. Just select "Nonprofit" or "PBC" when creating an opportunity.*

---

## D. The Vision — Five Core Jobs

Every Bedrock feature traces back to one of these. If it doesn't serve one of these five, it doesn't get built.

1. **Know who we're talking to and why.** Clean, unified records of every organization, contact, and prospect — with relationship history, not just data fields. When someone leaves Pursuit, the institutional knowledge stays.

2. **Track every dollar through its lifecycle.** From "we identified a funder" through "proposal sent" through "award signed" through "invoice paid" — one continuous thread, not scattered across Salesforce, Sage, and spreadsheets.

3. **Tell us what to do this week — and remember why we decided it.** Surface time-sensitive actions automatically. Grant deadlines, follow-up calls, stalled deals, overdue tasks — prioritized and assigned. Record the reasoning behind pursue/pass/deprioritize decisions so institutional knowledge survives turnover.

4. **Show leadership where the money stands.** Accurate pipeline value, weighted forecasts, cash flow projections, and revenue by stream — available in seconds, not after an hour of number-pulling.

5. **Keep Salesforce and Sage as sources of truth.** Bedrock doesn't replace your systems of record — it makes them work together. Data entered in one place appears in all three. No re-keying.

---

## E. Pebble's Full Evolution

### The 4-Stage Roadmap

Each stage builds on the last. Each delivers full user capability — no half-built features.

**Stage 1: Research Quality + UX** *(Complete today)*
Sourced profiles with confidence scoring, session history, human feedback, and markdown export. Data from ProPublica 990s, SEC EDGAR filings, FEC political contributions, Wikipedia, USAspending, and OpenCorporates. Every claim links to its source so you can verify.

*What this means for your daily work:* Instead of 20 minutes Googling a prospect before a meeting, you get a verified, sourced brief in 30 seconds. JP and Jac are testing this now.

**Stage 2: Internal Data Integration** *(Next)*
Pebble checks Salesforce before researching — if you already have a relationship with this person, Pebble tells you instead of starting from scratch. LinkedIn connections stored on the server (not just in your browser). Your own giving history enriches profiles.

*What this means:* Pebble stops duplicating work you've already done. It knows who you know and uses that context to give smarter answers.

**Stage 3: Bulk Research + Categorization**
Upload 100 prospect names. Pebble runs a quick identity check on all of them — confirming who they are and flagging ambiguous matches. You review the results, select who's worth a deeper look, and Pebble runs structured research only on the ones you choose. The best fits get auto-categorized (renewal candidate, warm intro available, insufficient giving capacity, cold prospect), and follow-up tasks are created in Salesforce for the winners. No money wasted on the wrong person.

*What this means:* Prospect research that took weeks — scanning spreadsheets, Googling names, manually categorizing — becomes a morning's work. You review results, not raw data.

**Stage 4: Live Assistant + Path Recommendations**
Pebble runs proactively. New contact added? Auto-researched. Profile going stale? Flagged. Warm intro path available through your network? Surfaced before you ask. Pebble stops just reporting facts and starts recommending actions.

*What this means:* You stop asking Pebble questions. Pebble comes to you: "This foundation's fiscal year ends next month. Your proposal should go out this week. Here's who on your team has the strongest connection."

### How You'll Talk to Pebble: Ask Pebble

Today Pebble researches one prospect at a time. Ask Pebble changes that — it's a conversational interface where you type a question and Pebble decides how deep to go.

**Three levels of depth:**

- **Quick CRM answers** (free, instant) — "What's Jane Smith's title?" or "Show me open opportunities with Acme." Pebble checks Salesforce and responds in under a second. No AI cost.
- **Structured research** (seconds, pennies) — "What's Jane's public giving look like?" Pebble pulls from public records, SEC filings, and nonprofit databases to build a structured profile across five dimensions: giving capacity, affiliations, board positions, wealth indicators, and comparable giving.
- **Full research briefs** (minutes, modest cost) — "Run a full brief on Jane." Pebble runs its complete research pipeline — multiple AI agents cross-referencing sources, verifying claims, and producing a comprehensive profile with confidence ratings.

**You're always in control.** Pebble never spends research budget without your say-so. It starts cheap, shows what it found, and asks if you want to go deeper. If you ask about "John Smith" and there are three in Salesforce, Pebble shows all three and asks you to pick — so it never researches the wrong person.

**Pebble knows its lane.** Need to draft an email or brainstorm strategy? Pebble hands you off to CoWork, Pursuit's general AI workspace. Pebble stays focused on research and CRM intelligence — that's what it's built for.

*For technical details, see the [Ask Pebble design spec](crm-prds/ask-pebble-spec.md).*

### How Pebble Works: Bounded Autonomy

Think of Pebble not as a single AI, but as a *team* of specialized researchers with a manager:

- **Workers** handle narrow tasks — extract data from one source, verify one claim
- **Specialists** analyze patterns across multiple sources — wealth indicators, philanthropy signals, political connections
- **A synthesizer** combines verified findings into a coherent profile with confidence ratings

Where this is going: workers organized into specialized clusters. A financial cluster cross-references political donations against nonprofit filings against federal awards. An affiliation cluster verifies board positions against Wikipedia entries against corporate registrations. Each cluster has a budget cap and time limit — they do their best within those bounds and flag anything uncertain for you to review.

Every agent operates within boundaries. There's a budget cap per prospect ($0.50 today). Agents can't take new research directions without checking with the orchestrator first. If something looks promising but expensive, it escalates rather than exploring on its own.

This is bounded autonomy — powerful enough to surface insights humans would miss, constrained enough to never run away with your money or your data.

The end state: give Pebble a name, and it comes back not just with "here's what we know" but with "here's what we recommend you do about it — and here's the path to get there."

### The North Star: AI Portfolio Intelligence

Each team member owns 20-30 Opportunities. Today, assignment is manual — based on who has bandwidth or who knows the funder. In the future, Bedrock will analyze all available context:

- **Relationship history** — Who has the deepest connection to this funder?
- **Sector alignment** — Who specializes in government vs. corporate vs. foundation?
- **Workload balance** — Who's overloaded? Who has capacity?
- **Pipeline composition** — Does this person's portfolio have enough diversity, or too much concentration risk?
- **Funder preferences** — Does this funder respond better to certain approaches?

...and recommend: "Move Opportunity X from Person A to Person B. Here's why."

This is the knockout capability. Bedrock doesn't just track your portfolio — it makes your portfolio smarter. It combines everything Pebble knows about the prospect with everything Bedrock knows about your team.

### Long-Term Home

Bedrock is being built to eventually merge into Pursuit's unified AI-native learning platform (alongside Pathfinder for learner operations). One login, one platform — fundraising tools alongside workforce development tools. The technology choices being made today are already aligned with that future.

---

## F. Task Request System (Planned)

### What It Is

Task Requests let Project Managers coordinate with Relationship Managers without directly editing Opportunities they don't own. It's an approval-based workflow: the PM proposes a task, the Opportunity owner reviews and accepts or rejects.

### How It Works

1. **PM creates a request.** From any page where you see an Opportunity — Projects, Pipeline, Dashboard, or search results — click "Request Task on Opportunity."

2. **Fill in the details:**
   - Select the Opportunity (search by name or account)
   - Enter a task subject: "Submit Robin Hood Q1 progress report"
   - Add an optional description with context
   - Propose a due date

3. **Owner gets notified.** The Opportunity owner sees a notification in their bell icon: "Laura requested a task on Robin Hood Foundation Grant: Submit Q1 progress report by April 15."

4. **Owner reviews and decides:**
   - **Accept** — a real Salesforce Task is created on the Opportunity with the proposed details. The RM now owns the task and sees it in their inbox.
   - **Reject** — with an optional reason. The PM sees the rejection and reason in their outgoing requests list.

5. **PM tracks status.** A "My Task Requests" view shows all outgoing requests with their current status: pending, accepted, or rejected.

### Why This Pattern

- **Ownership stays clean.** RMs are accountable for their Opportunities. Nobody adds tasks or changes data without their consent.
- **Coordination happens naturally.** PMs don't need to chase RMs on Slack or email — the request lives in the system with a clear accept/reject workflow.
- **Audit trail.** Every request is logged with who requested, who approved/rejected, and when. No "I thought you were handling that" ambiguity.
- **Foundation for the future.** This same pattern — request, review, accept/reject — extends to other types of cross-team edits as Bedrock matures. Eventually, any user can request changes to objects they don't own, and the owner approves.

---

## G. What's Coming Next — Feature Roadmap

Features are organized by when they'll be available, not by technical complexity. Dates are targets, not commitments.

### Shipping with Beta (Now)

- Permission profiles for 3 roles (RM, Executive, PM)
- Role-specific nav visibility (RMs see 4 pages, others see 5)
- Project write permissions gated to PMs and Admin
- Pebble access gated to JP and Jac for testing

### Weeks 1-2 Post-Launch

- **Task Request system** — PMs can request tasks on RMs' Opportunities (see Section F)
- **Project ownership model** — define who can edit and delete each project; owner-only delete with contributor access

### Weeks 2-4 Post-Launch

- **Activity timeline** — call, email, meeting, and note history per Contact and Opportunity, displayed as a chronological feed
- **Activity detail modals** — click into any activity to see full details and linked records

### Weeks 3-5 Post-Launch

- **Chrome extension** — log emails and meetings from Gmail and Google Calendar directly into Bedrock without switching tabs

### After Beta Stabilizes

- **Pebble self-service** — AI prospect research for the team, with per-user daily and monthly budget caps
- **Slack-to-Salesforce automation** — post pipeline updates in Slack; Bedrock captures them, proposes the change, and waits for your approval
- **Complex Gantt dependencies** — multi-predecessor task chains, critical path highlighting
- **Grant requirements capture** — reporting schedules, program metrics, and funder obligations for nonprofit grants
- **Decision audit trail** — record why you pursued, passed on, or deprioritized a prospect, with a frozen snapshot of the data at decision time

### On the Roadmap (2-3 Months)

- Sage Intacct integration (invoice push, payment pull, reconciliation)
- AI portfolio recommendations (who should own which Opportunities, and why)
- Pebble bulk research (quick-check hundreds → deep-research the best fits)
- Concentration risk alerts (flag when >30% of pipeline depends on one funder)
- Kanban drag-and-drop pipeline view

---

## H. How Priority Opportunities Scoring Works

The Priorities page ranks your open opportunities using **two separate systems** that serve different purposes.

### Rank Order (the # column)

This controls the sort position — which deals appear at the top of the table.

- **"Total" mode:** Sorted by dollar Amount, biggest first. A $5M deal always ranks above a $100K deal.
- **"Weighted" mode:** Sorted by Amount x Probability, with a slight log-scale bonus for very large deals. A $1M deal at 50% probability (~$500K weighted) ranks above a $500K deal at 80% (~$400K weighted).

The # is purely a position indicator — it tells you where the deal falls in your portfolio by financial impact.

### Urgency Alerts (the Alerts column)

This surfaces what needs your attention *right now*. Each condition adds points to an urgency score and shows a colored chip. Multiple alerts can stack on the same opportunity.

| Alert | What it means | Points | Color |
|-------|--------------|--------|-------|
| Overdue by X days | Close date has passed | +40 | Amber |
| Closing in X days | Close date within 7 or 30 days | +15 to +30 | Green |
| X overdue tasks | Tasks past their due date | +20 | Amber |
| No tasks assigned | No open tasks — nobody has a next action | +10 | Blue |
| Stale — X days | No activity (modification or task/event) in 30+ days | +15 | Blue |
| Quiet Xd+ ($Ym) | Large deal ($250K+) with no activity, escalating severity | +10 to +30 | Amber |
| Meeting in X days | Upcoming meeting — time to prep | +10 | Blue |
| Renewal | Opportunity marked as renewal (RenewalRepeat field) | +5 | Purple |
| Upsell | Opportunity marked as upsell | +5 | Purple |

**The urgency score determines the rank dot color** (the circle around the # number), not the sort order:
- **Amber dot** — has overdue tasks (something is late)
- **Green dot** — closing soon (deal is progressing toward close)
- **Blue dot** — has informational alerts (stale, no tasks, meeting prep)
- **Gray dot** — no alerts

### Color System

Alerts use a consistent color language across the entire application:

- **Red** = Priority/severity (High priority tasks, critical issues)
- **Amber** = Temporal pressure (overdue, time-sensitive — something is late or stalling)
- **Green** = Closing momentum (deal approaching Collecting / In Effect stage)
- **Blue** = Informational (no tasks, stale, meeting prep — things to know, not alarms)
- **Purple** = Relationship tags (Renewal, Upsell — protecting existing revenue)

### Why Two Systems?

The rank order answers: *"Which deals matter most financially?"*
The urgency alerts answer: *"Which deals need action right now?"*

A $20M deal with no alerts still ranks #1 — it's your biggest opportunity. But a $100K deal with overdue tasks and a stale pipeline gets amber chips screaming for attention. Both signals are useful; combining them into one score would blur the distinction.

---

## I. Glossary

### General terms

| Term | Definition |
|------|-----------|
| **Opportunity** | A specific fundraising deal — a grant application, a contract, a sponsorship |
| **Pipeline** | All active opportunities, organized by how far along they are |
| **Stage** | Where a deal is in its lifecycle, from initial identification through proposal and negotiation to a final outcome (won or lost) |
| **Prospect** | A potential funder who hasn't yet been qualified into the pipeline |
| **Weighted pipeline** | Pipeline value adjusted by probability. A $100K deal at 50% probability counts as $50K |
| **Revenue stream** | Whether an opportunity is a nonprofit grant or a PBC contract |
| **Relationship Manager (RM)** | A team member accountable for updating and progressing their portfolio of Opportunities. RMs own their deals — they control stages, amounts, close dates, and tasks |
| **Project Manager (PM)** | A team member managing Projects — workstreams, milestones, and project tasks — and coordinating with RMs via Task Requests |
| **Permission Profile** | The set of access rights assigned to a user. Determines which pages are visible and what actions are allowed. Managed by the Admin (JP) |
| **Task Request** | A PM's proposal to create a task on an Opportunity they don't own. The Opportunity owner reviews the request and accepts (creating a real Salesforce Task) or rejects (with an optional reason) |
| **Pebble profile** | The AI-generated research brief for a contact, with sourced claims and confidence scoring |
| **Claim** | A specific piece of information in a Pebble profile (e.g., "Board member of XYZ Foundation") with its source linked |
| **Automation Review** | The queue where AI-proposed changes (from Slack, calendar, etc.) wait for human approval before being applied to Salesforce |
| **Portfolio** | The set of opportunities a team member owns and manages |
| **Ask Pebble** | The conversational interface for querying CRM data and requesting prospect research — from quick lookups to full research briefs. Lives on the Pebble page; eventually a floating assistant on every Bedrock page |
| **CoWork** | Pursuit's Claude-powered AI workspace for drafting, analysis, and general tasks. Pebble handles research and CRM intelligence; CoWork handles everything else |
| **Tiered Research** | Pebble's progressive approach — quick identity check (T1), structured intelligence across 5 dimensions (T2), full verified research brief (T3). Each tier requires your approval before spending |
| **CRM Bridge** | The connection between Pebble and Bedrock that lets Pebble query Salesforce data directly for instant answers about contacts, accounts, and opportunities |

### Opportunity stages — decision matrix (DRAFT, pending fundraising sign-off)

Pursuit's live Salesforce org carries **22 distinct StageName values** on Opportunity records (verified 2026-04-14 via SOQL against prod). Of those, **13 are declared in our code enums** (`frontend/src/types/salesforce.ts:OPPORTUNITY_STAGES` + `financial_forecasting/models.py:OpportunityStage`) and **9 are not** — meaning code branches that assume the enum can silently misbehave on ~1,300 live records. Full drift analysis in `tasks/stage-schema-drift.md`.

**Status:** This is a DRAFT skeleton. JP + fundraising team to sit down and classify each stage using the matrix below. Once the "Pursuit decision" column is filled in, F1/F2/F3 in the drift doc can ship.

**Classification categories:**

- **active** — deal in progress, should appear in the Pipeline Flow funnel bars
- **won (terminal)** — deal closed, revenue earned or owed; counts toward FY wins and Individual Goals
- **won-collecting** — deal signed, revenue being received over time (also counts toward wins, but drives different Intacct behavior)
- **lost** — deal closed without revenue; counts against conversion but not toward goals
- **legacy / do-not-use** — historical values still attached to records; no new records should use; filter out of edit dropdowns but preserve on existing records

**The 13 already in the enum** are classified in `WON_STAGES` / `LOST_STAGES` in `frontend/src/types/salesforce.ts`. Those are not in scope for this conversation — skip them.

**The 9 NOT in the enum (need classification):**

| Stage | Live count | Best-guess category | Questions for fundraising | Pursuit decision |
|---|---:|---|---|---|
| `In Collection` | 650 | **won-collecting** (alias for `Collecting / In Effect`?) | Is this functionally identical to `Collecting / In Effect`, or different? Are new records still being created with it, or only legacy? | _TBD_ |
| `Closed Won` | 575 | **won (legacy)** — parallel to `Closed / Completed` | Any operational difference vs `Closed / Completed`, or pure legacy naming? Should Intacct auto-invoice fire on these? | _TBD_ |
| `Close/Unknown` | 68 | **legacy / do-not-use** (dirty data) | Recoverable, or truly unknown? Worth a data-cleanup pass to move these to a real stage? | _TBD_ |
| `Closed / Full-Time or Successful Conversion` | 14 | **won (PBC variant)** | Is this specifically a PBC outcome where a Fellow converted to full-time? Does it generate billable revenue? | _TBD_ |
| `Closed / Temporary Hire` | 5 | **won (PBC variant)** | PBC-specific? Revenue-producing? | _TBD_ |
| `Closed / Fulfilled` | 5 | **won (probably)** — which program? | Which Pursuit program uses "Fulfilled"? Corporate partnerships? | _TBD_ |
| `Closed / Contract or Agreement But No Fellows Hired` | 4 | **lost** (contract signed, zero revenue) | Confirm: a PBC contract that didn't produce fellow placements is counted as lost? | _TBD_ |
| `Contract Signing` | 3 | **active** (late-funnel, pre-close) | Sits between `Contract Creation` and `Collecting / In Effect`? | _TBD_ |
| `Closed / Sourcing` | 2 | **TBD** — misleading name | Name suggests active (sourcing candidates), but prefixed `Closed /`. Which is it? | _TBD_ |
| `Verbal Commitment` | 1 | **active** (pre-contract) | Where in the funnel — before `Contract Creation`? Or is it post-proposal and pre-contract specifically? | _TBD_ |

**Questions for the meeting (in addition to the table):**

1. **The 4 PBC-prefixed stages** (`Full-Time or Successful Conversion`, `Temporary Hire`, `Contract or Agreement But No Fellows Hired`, `Sourcing`) — should we introduce a `PBC_STAGES` / `PBC_WON_STAGES` labeled subset, or just fold them into the existing `WON_STAGES` / `LOST_STAGES`? Separate bucket gives us dashboards that can report "PBC outcomes" cleanly.
2. **Intacct auto-invoicing** (currently `data_sync.py:565, 916` fires only on `StageName = 'Closed Won'`, which skips 1,923 `Closed / Completed` records = 77% of won opps). Which stages SHOULD trigger an Intacct invoice draft? Probably at minimum `Closed Won` + `Closed / Completed`, possibly some of the PBC success variants.
3. **Edit UI surfacing** — once we sync the enum to reality, the stage dropdown on Opportunity edit forms (`PipelineFilterBar`, `StageCell`, `OpportunityEditDialog`) will show ~22 options. Do we want a `LEGACY_STAGES` flag that excludes some from the dropdown (so users can't pick `Close/Unknown` for new work) while preserving them on existing records? Leaning yes.
4. **Sanity check on `In Collection`** — is the difference vs `Collecting / In Effect` a deliberate business distinction (e.g., `In Collection` = "money is past due") or historical? 650 records is a lot.

**What changes once this is signed off:**

- F1 — expand `WON_STAGES` / `LOST_STAGES` in `frontend/src/types/salesforce.ts` to `Set<string>` (allowing values outside the tight union) and add the classifications above. Maybe also introduce `REVENUE_EARNING_STAGES = WON_STAGES ∪ {Collecting / In Effect, In Collection}` for dashboards that want "we have the money or are getting it" as one bucket.
- F2 — fix `data_sync.py:565, 916` Intacct invoice query to `WHERE StageName IN (...)` covering the full won-equivalent set.
- F3 — sync `OPPORTUNITY_STAGES` enum to the live picklist, update `salesforce.test.ts`, update edit-UI dropdowns (add legacy flag).

All three stay deferred until the "Pursuit decision" column above is filled in.
