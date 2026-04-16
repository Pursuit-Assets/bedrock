# Home Page Spec: Customizable Landing with Calendar, Top Prospects & Actions

**Status:** Draft  
**Audience:** CEO (Nick), fundraising team  
**Goal:** One go-to productivity and strategy view: top accounts, calendarized meetings with external partners, top prospects by weighted priority, and follow-ups/action items—with fast load and secure design.

---

## 1. Calendarized view (day / week / 2 weeks)

### 1.1 One view, filterable range

- **Single calendarized view** on the home page (not separate pages).
- **Range filter:** User can switch between **Day**, **Week**, and **2 weeks** (default: Week). **No “Month”** — maximum range is **2 weeks** for all calendar and event queries to keep responses fast.
- **Display:** Events and tasks appear on the correct dates; empty states for “no meetings/tasks” in range.

### 1.2 Google Calendar: keyword matching + confirmation + manual mapping

- **Source:** User’s Google Calendar (existing OAuth and Calendar API).
- **Filter:** Include **only** events that match at least one of the following (keyword/match rules):
  - **Account name** — event title/description/attendees contain the Salesforce Account name (or significant substring).
  - **Contact** — match by **email as unique key**: any attendee email equals a Salesforce Contact’s Email.
  - **Prospect name** — event title/description contains the name (or significant substring) of a **Lead** (localStorage Leads: first_name + last_name, or organization).
  - **Opportunity name** — event title/description contains the Salesforce Opportunity Name (or significant substring).

**Matching confirmation and manual mapping:**

- **Show suggested mapping:** For each calendar event returned, display the **suggested link** to SF/database object(s) (Account, Contact, Opportunity, Lead) that produced the match.
- **Confirm or change mapping:** User can **confirm** the suggestion or **manually change** the mapping (e.g. pick a different Account, link to a different Opportunity, or “None” to unlink).
- **Persist user mappings:** Store user-confirmed and user-corrected mappings (e.g. `event_id → { account_id?, contact_id?, opportunity_id?, lead_id? }`) in the app (localStorage or, when available, backend per user) so future loads reuse them and the system can learn from them.
- **Feedback loop for the calendar mapping tool:**
  - **Explicit feedback:** “Was this match correct?” (Yes / No / Edit) or “Suggest a better match” with optional free text. Submit to a feedback store (e.g. backend endpoint that stores `event_id`, suggested_match, user_action, optional_comment) for future model/tuning.
  - **Implicit signal:** User edits (manual reassignment) are treated as corrections; aggregate “suggested vs chosen” pairs to improve matching rules or ML later.
  - **No PII in feedback logs:** Store only IDs and match type; do not log event title/description/attendees in feedback payloads unless product explicitly approves.

**Implementation notes:**

- **Backend:** One new endpoint, e.g. `GET /api/calendar/home-events?start=YYYY-MM-DD&end=YYYY-MM-DD`.
  - Backend loads **once**: (1) Accounts (names), (2) Contacts (emails), (3) Opportunities (names), (4) Leads (names) — from SF + app context.
  - Backend fetches **one** Google Calendar response for the authenticated user for `[start, end]` (max 2 weeks).
  - Server-side filter: keep only events that match any of the above rules; return each event with **match_reasons** (which rule(s) fired: account_name, contact_email, prospect_name, opportunity_name) and **suggested_ids** (AccountId, ContactId, OpportunityId, LeadId) so the UI can show “Linked to: Account X” and allow override.
- **Optional:** `POST /api/calendar/event-mapping` (or PATCH) to save user-confirmed/corrected mapping and/or feedback for the loop.
- **Security:** Use existing Google tokens. Do not log event content in feedback; only IDs and match metadata.
- **Performance:** Single calendar fetch + in-memory filter. Cache Account/Contact/Opportunity/Lead lists briefly (e.g. 1–5 min).

### 1.3 What appears on the calendar

- **Google Calendar events** that pass the keyword/match filter, with **confirmed or corrected** mapping to SF/database objects where the user has set it.
- **Salesforce Tasks** (see §3) with **ActivityDate** in range, so “follow-up” and action items appear on the right dates.

---

## 2. Top prospects list (configurable count, weighted ranking)

### 2.1 User choice: 5, 10, or 25

- **Setting:** “Show top **5** / **10** / **25** prospects” (e.g. dropdown or segmented control). Default: **10**.
- **Persistence:** Store in localStorage (e.g. `pursuit-home-top-n`) so the choice survives refresh.

### 2.2 What “prospects” means here

- **Prospects** = open **Opportunities** (non-closed, non-withdrawn) that the user owns (or that are visible to them).  
- Each row is an opportunity; “prospect” in this section = the opportunity + its account/context.

### 2.3 Priority ranking: probability and amount weighted together

**Best practice (fundraising/sales pipeline):**

- **Weighted pipeline** = Amount × (Probability / 100) is the standard expected-value formula (see PandaDoc, Coefficient, Forecast.io). It already combines amount and probability; the goal is to extend it so **large deals get appropriate lift** without a hard cutoff, and **probability always matters**.

**Proposed formula (continuous, no pure threshold):**

1. **Base expected value:**  
   `W = Amount × (Probability / 100)`  
   (Use Salesforce **Amount** and **Probability**; if Probability is null, use stage-based default.)

2. **Size factor (smooth boost for larger deals):**  
   Use a **continuous** function of amount so that bigger deals get a modest boost that scales with both amount and probability, with **$1M as the reference** but not a step threshold:  
   - `size_factor = 1 + log10(1 + Amount / 1_000_000)`  
   - So: $100k → ~1.04, $1M → ~1.30, $5M → ~1.78. The boost grows with size but stays bounded.

3. **Priority score (combined):**  
   `score = W × size_factor = Amount × (Probability / 100) × (1 + log10(1 + Amount / 1_000_000))`  
   - Probability and amount are **weighted together**: higher probability always helps; larger amount helps more as size grows, without a cliff at $1M.
   - A $100k deal at 80% has score ~83k; a $5M deal at 30% has score ~2.67M — so the big ticket ranks higher, but a $5M deal at 10% stays below many high-probability smaller deals.

4. **Probability floor:**  
   **Exclude** opportunities with `Probability < 15%` from the “top prospects” list so the list stays actionable. (Confirmed: 15% floor.)

5. **Sort:**  
   Sort by `score` descending; take top **N** (5, 10, or 25).

**Concrete parameters:**

| Rule | Value | Purpose |
|------|--------|---------|
| Probability floor | &lt; 15% → exclude from list | Focus on actionable prospects |
| Size reference | $1M in log term | Smooth boost; no hard threshold |
| Formula | `W × (1 + log10(1 + Amount/1e6))` | Probability and amount weighted together |

**Display:** List shows opportunity name, account, amount, probability, close date, and optionally stage. Click-through to opportunity/pipeline.

---

## 3. Tasks (existing + home aggregation)

### 3.1 Current state

- **Salesforce Tasks** exist and are linked to **Opportunities**.
- **API:** `GET /api/salesforce/opportunities/{id}/tasks` returns tasks for one opportunity (Subject, Status, Priority, **ActivityDate**, etc.).
- **UI:** TaskPanel on the Opportunities page; create/update/delete work.

### 3.2 Gap for home page

- There is **no** “all my tasks in a date range” endpoint. The home page needs **one** list (or calendar feed) of tasks for the current user in the selected day/week/2-weeks range.
- **Proposal:** New endpoint, e.g. `GET /api/salesforce/my-tasks?start=YYYY-MM-DD&end=YYYY-MM-DD`.
  - Backend: Query Salesforce **Task** where `OwnerId = current_user_salesforce_id` and `ActivityDate >= start` and `ActivityDate <= end`, and `Status != 'Completed'` (or include completed with a visual distinction).
  - Return tasks with minimal opportunity/account context (e.g. opportunity name, account name) so the home calendar/list can show “Follow up re: X” with link to opportunity.

### 3.3 Activity-driven dates: Meetings/emails → Activity; Slack → Chatter + Activity

**Goal:** Keep **LastActivityDate** accurate on Opportunity, Account, Contact, and Lead by ingesting Gmail, calendar meetings, and Slack, then writing to Salesforce in a consistent way. Use **Activity** (Task/Event) so LastActivityDate updates; use **Chatter** for Slack so the feed is visible; always create an **Activity** that summarizes so activity dates stay correct.

**Meetings and emails:**

- **Write:** Create an **Activity** (Task or Event) linked to the related Account, Contact, Opportunity, and/or Lead (WhatId/WhoId). Do **not** use Chatter for meetings/emails as the primary write — Activity is the source of truth for LastActivityDate. Optionally post a one-line summary to Chatter for feed visibility after creating the Activity.

**Slack:**

- **Write (two steps):** (1) Post the Slack message (or a short summary) to **Chatter** on the related Account, Contact, Opportunity, and/or Lead so the team sees it in the feed. (2) Create an **Activity** (Task) that **summarizes** the Slack (e.g. “Slack: [channel] — [one-line summary]”) and link it to the same record(s). The Activity is what updates LastActivityDate; Chatter gives visibility.

**Pending tasks inferred from content:**

- If the automation infers a **pending task** (e.g. “Follow up with X by Friday” or “Send proposal to Y”), **create the task only after user validation**. Do **not** auto-assign or create without review. Put proposed tasks in a **review queue** (e.g. “Suggested tasks” in the weekly review); users confirm, edit (assignee, date, subject), or reject. Only after confirmation do we create the Task in Salesforce and assign. Validate with users before assigning out.

**Token and cost control:** Process in batch or on-demand (e.g. “Sync last 24h”). Use the org’s Claude subscription for summaries; keep prompts small and cache where possible.

**Active Comms vs Inactive (two sections on home):** Unchanged — Active = last 60 days; Inactive = last year, not last 60 days. Depends on Activity (and optionally Chatter) keeping LastActivityDate correct.

**Claude subscription:** All in-app Claude usage via a single backend API key tied to the org’s subscription; document and monitor. See §6.1 for Task vs Chatter.

---

### 3.4 Weekly review process for automations

**Goal:** Every week (or on demand), the team **reviews** what the automation did and confirms it was correct or gives feedback so we can improve matching, task generation, and prioritization ranking.

**Process:**

1. **Review queue:** A dedicated view (e.g. “Automation review” or a section on Home) lists recent automation actions: created Activities, Chatter posts, and **suggested tasks** that are pending confirmation. Filter by date range (e.g. last 7 days).
2. **Confirm or correct:** For each item, the user can **confirm** (“Yes, correct”), **edit** (fix the linked Account/Contact/Opportunity/Lead, or edit the task subject/assignee/date before creating), or **reject** (“Wrong match” / “Don’t create this task”).
3. **Feedback for improvement:** When the user edits or rejects, we capture **feedback**: e.g. “Suggested match was X; user chose Y” or “User rejected suggested task because …”. Store in a feedback store (backend) with no PII in logs — only IDs and action type — so we can tune matching, task generation, and prioritization over time.
4. **Suggested tasks:** Suggested tasks stay in “pending” until the user confirms in the review. After confirmation, create the Task in Salesforce and assign; if the user edits, create with the edited fields.
5. **Cadence:** Default is **weekly** (e.g. every Monday); allow ad hoc review anytime. Optionally remind the team if the queue has items older than N days.

**What we review:** (1) **Matching** — Did we link the right Account/Contact/Opportunity/Lead to this meeting/email/Slack? (2) **Task generation** — Were suggested tasks appropriate? (3) **Prioritization** — No direct “review” of ranking formula here, but feedback on “this shouldn’t be in top 10” or “this was missing” can be stored and used to refine the priority formula or data quality.

---

## 4. Date fields for calendarizing and prioritization

Use these consistently so the home page and calendar stay aligned with SF and product semantics.

| Object | Date field | Use on home |
|--------|------------|-------------|
| **Opportunity** | **CloseDate** | Primary “by when”; drives action items and “follow up before close.” |
| **Task** | **ActivityDate** | Due date for the task; place on calendar and in “action items” list. |
| **Contact** | **LastActivityDate** | Target: keep accurate via Gmail/Slack → Chatter (§3.3). Drives **Active Comms** (≤60 days) vs **Inactive** (last year, not last 60 days). |
| **Lead** | **last_activity_at** (app) or SF LastActivityDate | App Leads: dedicated **last_activity_at** field, updated when Gmail/Slack matches the lead (§6.2). SF Leads: Task with WhoId updates LastActivityDate. Fall back to linked opportunity’s CloseDate when useful. |

**When in doubt:** Ask product to identify the canonical “action date” or “follow-up date” per object so we calendarize and prioritize consistently.

---

## 5. Home page layout (summary)

- **Top:** Greeting + range selector (**Day / Week / 2 weeks**) for the calendar and action items.
- **Calendarized block:** Single view (max 2 weeks) showing:
  - **Google Calendar events** with **matching confirmation and manual mapping** (§1.2); show suggested link to Account/Contact/Opportunity/Lead and let user confirm or change; **feedback loop** to improve mapping over time.
  - **Tasks** (ActivityDate in range) with link to opportunity.
- **Top N prospects:** List of 5, 10, or 25 opportunities, ranked by the **combined priority formula** (§2.3): Amount and probability weighted together (smooth size factor, 15% probability floor).
- **Active Comms:** Contacts and Leads with **activity in the last 60 days** (LastActivityDate), to track back-and-forth needed to move Opportunities. Depends on Gmail/Slack → Activity (and Chatter for Slack) keeping LastActivityDate correct (§3.3).
- **Inactive:** Contacts and Leads with **activity in the last year but not in the last 60 days** — relationships that may need re-engagement.
- **Action items:** Tasks due in range; “opportunities closing soon” (CloseDate in range).
- **Automation review (weekly):** Review queue for recent automations (Activities, Chatter, suggested tasks); confirm, edit, or reject; give feedback to improve matching, task generation, and prioritization (§3.4).

**Performance:**

- **Fast load:** One (or few) API calls: e.g. `home-events`, `my-tasks`, `opportunities` (for ranking). No N+1 (e.g. no “fetch tasks per opportunity” in a loop). Cache opportunities and account/contact lists where appropriate.
- **Progressive loading:** Show structure and “Top prospects” from cached or first response; then fill calendar and tasks. Consider loading calendar only when the section is visible (e.g. in viewport) if we want to prioritize first paint.

**Security:**

- Calendar and tasks are **per authenticated user** (and per SF owner where applicable). No cross-user data.
- Keyword matching is done server-side; only matching events are returned to the client.

---

## 6. Decisions: Lead last activity & how we update LastActivityDate

**Summary:** (1) Use **Task** (or Event), not Chatter alone, to update LastActivityDate in Salesforce; optionally post to Chatter for visibility. (2) For **app Leads**, add a **last_activity_at** field and update it when Gmail/Slack matches the lead; for **Salesforce Leads**, create a Task with WhoId = Lead so SF LastActivityDate updates.

---

### 6.1 How to update LastActivityDate (Meetings/emails → Activity; Slack → Chatter + Activity)

**Meetings and emails:** Use **Activity** only. Create a Task (or Event) with WhatId/WhoId so LastActivityDate updates. Optionally post a one-line summary to Chatter after creating the Activity for feed visibility.

**Slack:** (1) Post to **Chatter** on the related record so the team sees the Slack in the feed. (2) Create an **Activity** (Task) that summarizes the Slack and link it to the same record(s) so LastActivityDate updates. Chatter alone does not update LastActivityDate in Salesforce.

**Decision:** Meetings/emails → **Activity** (Task/Event); Slack → **Chatter** (for visibility) **plus** an **Activity** that summarizes (for LastActivityDate).

---

### 6.2 Lead “last activity” (app Leads vs Salesforce Leads)

**Recommendation: Dedicated field for app Leads; Task for SF Leads when applicable.**

- **Leads in our app (localStorage today):** There is no Salesforce Lead record to attach a Task to. Use a **dedicated field** on the Lead type: e.g. **`last_activity_at`** (ISO datetime). When we process Gmail/Slack and match to a Lead (by name/email), update that Lead’s `last_activity_at` in localStorage (or future backend). For Active Comms / Inactive, use `last_activity_at` if present; otherwise fall back to **linked opportunity’s LastActivityDate or CloseDate** when the lead has `grant_id` set.
- **Leads in Salesforce (converted or synced):** When we have a Salesforce Lead Id, create a **Task** with **WhoId** = Lead Id so the Lead’s LastActivityDate updates in SF. No need for a synthetic “from Opportunity” for SF Leads—the Task does the job.
- **Synthetic fallback:** For app Leads with no `last_activity_at` yet, we can show “last activity” as the linked opportunity’s CloseDate or LastActivityDate for “follow up by” context only; the primary source for “Active Comms” remains `last_activity_at` once we have it.

**Decision:**  
- **App Leads:** Add **`last_activity_at`** to the Lead type; update it when Gmail/Slack matches the lead; use it for Active/Inactive; fall back to linked opportunity date when useful.  
- **Salesforce Leads:** Create Task with WhoId = Lead so LastActivityDate updates in SF.

---

### 6.3 Where to store Leads (Salesforce vs learning-platform DB)

**Recommendation: Use Salesforce Lead as the system of record for fundraising prospects; no separate DB required. When Bedrock merges into the learning platform, optional sync to a dedicated PG table.**

- **Salesforce:** Salesforce has a native **Lead** object. Bedrock fundraising leads (prospects) can be saved **in Salesforce** as Lead records. The SF data model supports it; we do **not** need a separate database for Leads. Sync from the app (e.g. “Add to Leads” or CSV import) to SF Lead via the Salesforce API; optionally store a `salesforce_lead_id` on any local/cache record for two-way sync.
- **Learning platform:** The learning platform’s existing **`lead`** table is for **admissions/marketing** leads (prospective Builders), not fundraising prospects. To avoid conflating the two:
  - **Option A (recommended for now):** Keep Bedrock leads in **Salesforce only**. No new table in the learning platform DB. When the unified app calls learning-platform APIs, it uses SF as source of truth for fundraising leads.
  - **Option B (post-merge):** Add a **`fundraising_lead`** (or `bedrock_lead`) table in the learning platform PostgreSQL for features that need to join to platform data (e.g. “this prospect attended workshop X” or cross-reference with `users`/`applicant`). Sync from SF to this table or write from Bedrock and sync to SF; keep a clear mapping (e.g. `salesforce_lead_id`) so we have one system of record (SF) and optional PG copy for analytics or joins.

**Decision:** Store Bedrock Leads in **Salesforce Lead**. The SF database architecture allows it; no separate DB required. When Bedrock is merged into the learning platform, optionally introduce a `fundraising_lead` table in PostgreSQL for cross-platform joins, with SF remaining the system of record.

---

## 7. Implementation checklist (high level)

- [ ] **Backend: Calendar** — Add `GET /api/calendar/home-events?start=&end=` (max 2 weeks); return events with **match_reasons** and **suggested_ids** (Account, Contact, Opportunity, Lead) for confirmation and manual mapping.
- [ ] **Backend: Calendar mapping & feedback** — Persist user-confirmed/corrected mappings; optional `POST /api/calendar/event-mapping` or feedback endpoint for the **feedback loop** (no PII in logs).
- [ ] **Backend: Tasks** — Add `GET /api/salesforce/my-tasks?start=&end=` for current user’s tasks in date range with opportunity/account context.
- [ ] **Frontend: Home** — Single calendarized view with **Day / Week / 2 weeks** selector; render Google events + Tasks (max 2 weeks); **matching confirmation and manual mapping** UI; feedback (“Was this match correct?” / Edit).
- [ ] **Frontend: Top prospects** — Configurable 5/10/25; **priority score** = `Amount × (Probability/100) × (1 + log10(1 + Amount/1e6))`; exclude Probability &lt; 15%; persist N in localStorage.
- [ ] **Frontend: Active Comms / Inactive** — Two sections: Active (LastActivityDate ≤ 60 days), Inactive (activity in last year, not last 60 days); depends on §3.3.
- [ ] **Backend: Gmail/meetings → Activity** — Ingest Gmail + calendar meetings; match to SF objects; create **Task** (WhatId/WhoId); optionally post one-line summary to Chatter. Batch/on-demand.
- [ ] **Backend: Slack → Chatter + Activity** — Ingest Slack; post to **Chatter** on related record(s); create an **Activity** (Task) that summarizes the Slack and link to same record(s) so LastActivityDate updates.
- [ ] **Backend: Suggested-task validation** — When automation infers a pending task, create it only **after** user confirmation. Expose suggested tasks in a review queue; user confirms, edits (assignee/date/subject), or rejects; then create Task in SF.
- [ ] **Backend + Frontend: Weekly review process** — “Automation review” view: list recent Activities/Chatter/suggested tasks (e.g. last 7 days); user confirms, edits, or rejects; capture feedback (match/task/priority) for improving matching and task generation. Cadence: weekly (e.g. Monday) + ad hoc.
- [ ] **App Leads:** Update **last_activity_at** when Gmail/Slack matches (§6.2). **Leads in SF:** Save to Salesforce Lead (§6.3); no separate DB required.
- [ ] **Claude subscription** — Route all in-app Claude/Anthropic calls through org’s Claude subscription (single API key in backend); document and monitor usage.

---

## References

- **Pipeline prioritization:** Weighted score = Amount × (Probability/100) is standard (PandaDoc, Coefficient, Forecast.io, North52). We extend with a continuous size factor so amount and probability are weighted together without a hard $1M threshold.
- **Existing app:** `MyDashboard.tsx`; `getAccountCalendarActivity(accountName)`; `TaskPanel` and `getOpportunityTasks(opportunityId)`; Activity Intelligence uses Anthropic/Claude in `simple_server.py`.
- **Data model:** `product/fundraising-team/raw-prds/prospect-dashboard/architecture/data-model.md`.
- **Calendar spec:** `product/fundraising-team/raw-prds/prospect-dashboard/specs/calendar-tasks.md`.
- **Learning platform (target for merge):** `product/learning-platform-integration.md`; app-context.md and database-schema.sql (React 19 + Vite + Tailwind + shadcn, Node + Express, PostgreSQL + pgvector, JWT). Bedrock will align with that stack and design when merged.
