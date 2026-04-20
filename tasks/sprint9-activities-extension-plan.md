# Sprint 9: Activities + Chrome Extension

**Status**: Planned (approved 2026-03-26)
**Sprints**: 9A (Foundation) → 9B (Timeline+Modals) → 9C (Extension) → 9D (Integration)

> **🔗 Cross-reference (2026-04-20):** The MVP objects-production-readiness master plan at `tasks/objects-production-readiness-plan.md` references this sprint in its PR sequence — specifically PR #157 (frontend Activities list page), PR #158 (Sprint 9A sync completion), and PR #159 (ActivityTimeline on detail dialogs). This Sprint 9 doc remains authoritative for Activities internals (schema, associations, search, AI insights, extension). The objects plan governs order-of-operations within the MVP scope; Sprint 9B-D (extension build, deep integration) remain post-MVP per the stretch parking lot.

## Context

Bedrock is rolling out to a 4-person team (started 2026-03-23). Salesforce remains source of truth for CRM data. The team needs Activities (logged meetings, emails, calls) brought into Bedrock and made searchable, plus a Chrome extension for logging emails and calendar events. This builds trust that Bedrock can eventually replace Salesforce entirely.

**Current state**: SF Tasks sync via CRUD endpoints. SF Events are NOT synced. Activity Intelligence panel aggregates real-time data from Slack/Fireflies/Gmail/Calendar/Drive but persists nothing locally. No Activity table exists in PostgreSQL. No Chrome extension exists.

## Decisions Made

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Storage model | Mirror (bidirectional) | SF stays source of truth. Team needs to trust Bedrock gradually. |
| 2 | History scope | All-time | Team must find everything in Bedrock that they'd find in SF. |
| 3 | Extension role | Associator (OAuth reads, extension associates) | ~500 lines, ships fast. Gmail/Calendar OAuth services already exist. |
| 4 | Association model | Opportunity-first with cascade | Auto-match → search → create Opp → Account → Contact. Account resolves from Opp (not Contact, due to dual affiliations). |
| 5 | Task linking | Suggest open Tasks in extension | After Opp selection, show related open Tasks. Optional link + mark complete. |
| 6 | Email storage | Full body + attachments to GCS | Plain text for search, HTML for display. Latest message + unsaved thread replies. Fake attachments filtered. 25MB/file, 50MB/activity limit. |
| 7 | Search | Scoped + Global | Scoped on entity views (always fast). Global via existing search bar (subject + snippet, 12-month default). |
| 8 | UI approach | Option C: Activity Timeline + on-demand AI | Chronological timeline as primary view. AI insights click-to-generate only (not automatic). Detail modal pattern (like Accounts) for Opportunities and Contacts. |
| 9 | Detail view | Modal (like Accounts page) | Accounts already has a 6-tab detail modal (MUI Dialog, maxWidth="lg"). Replicate for Opportunities and Contacts. Existing edit dialogs triggered from Edit button inside. |
| 10 | Sprint order | Foundation → Timeline+Modals → Extension → Integration | Each step verifiable in isolation. Display before capture so extension output is immediately visible. |
| 11 | SF sync scope | Both Tasks and Events | Complete Activity picture matching Salesforce's timeline. |

---

## Sprint 9A: Foundation (Backend Only — Zero Frontend Risk)

### Step 1: Query SF Activity volume

Run SOQL count queries to understand dataset size before writing migration code.

```sql
SELECT COUNT() FROM Task
SELECT COUNT() FROM Event
```

This determines batch sizes and whether we need any special pagination handling.

**Endpoint for manual trigger**: `POST /api/activities/sync/count` (admin-only)

### Step 2: Create `bedrock.activity` table

**File**: `financial_forecasting/db/init.sql`

Follow existing patterns: UUID PK, TIMESTAMPTZ, idempotent migration, trigger-based `updated_at`.

```sql
CREATE TABLE IF NOT EXISTS activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Salesforce identifiers (for mirror sync)
    sf_id TEXT UNIQUE,                    -- SF Task.Id or Event.Id
    sf_type TEXT CHECK (sf_type IN ('Task', 'Event')),

    -- Core fields
    type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'slack-message', 'calendar-event')),
    subject TEXT NOT NULL,
    description TEXT,                     -- Full body (plain text for search)
    description_html TEXT,                -- HTML version for display
    activity_date TIMESTAMPTZ NOT NULL,

    -- Association (Opportunity-first model)
    opportunity_id TEXT,                  -- SF Opportunity.Id (WhatId)
    account_id TEXT,                      -- SF Account.Id (resolved from Opp)
    contact_ids TEXT[] DEFAULT '{}',      -- SF Contact.Id[] (WhoId + participants)
    task_id UUID REFERENCES project_task(id) ON DELETE SET NULL,  -- Optional Bedrock Task link

    -- Source tracking
    source TEXT NOT NULL CHECK (source IN ('salesforce', 'extension', 'manual', 'gmail-sync', 'calendar-sync')),
    source_ref TEXT,                      -- External ID (gmail_message_id, gcal_event_id, etc.)
    source_thread_id TEXT,                -- Gmail thread ID for thread grouping

    -- Email-specific fields
    email_from TEXT,
    email_to TEXT[],
    email_cc TEXT[],
    email_snippet TEXT,                   -- First ~200 chars for search results

    -- Meeting-specific fields
    meeting_duration_minutes INTEGER,
    meeting_attendees JSONB,              -- [{name, email, status}]
    meeting_location TEXT,

    -- Attachments (GCS URLs)
    attachments JSONB DEFAULT '[]',       -- [{name, size, mime, gcs_url, gmail_attachment_id}]

    -- Ownership
    logged_by TEXT,                        -- SF User.Id who created/logged this
    owner_id TEXT,                         -- SF Owner.Id

    -- Sync metadata
    sf_last_modified TIMESTAMPTZ,         -- SF LastModifiedDate (for incremental sync)
    synced_at TIMESTAMPTZ,                -- When Bedrock last synced this record
    sf_sync_status TEXT DEFAULT 'synced' CHECK (sf_sync_status IN ('synced', 'pending', 'failed')),

    -- Full-text search
    search_vector TSVECTOR,

    -- Soft delete
    deleted_at TIMESTAMPTZ,               -- Never hard delete per entity-map

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_opportunity ON activity(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_activity_account ON activity(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_contact ON activity USING GIN(contact_ids);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity(activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity(source);
CREATE INDEX IF NOT EXISTS idx_activity_sf_id ON activity(sf_id);
CREATE INDEX IF NOT EXISTS idx_activity_search ON activity USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_activity_thread ON activity(source_thread_id);
CREATE INDEX IF NOT EXISTS idx_activity_not_deleted ON activity(deleted_at) WHERE deleted_at IS NULL;

-- Full-text search trigger
CREATE OR REPLACE FUNCTION activity_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.email_snippet, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_activity_search_vector
    BEFORE INSERT OR UPDATE ON activity
    FOR EACH ROW EXECUTE FUNCTION activity_search_vector_update();

-- Updated_at trigger (follows existing pattern)
CREATE TRIGGER trg_activity_updated_at
    BEFORE UPDATE ON activity
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Note**: All SQL must use `bedrock.` schema prefix per project conventions. The above is simplified; actual queries will prefix with `bedrock.activity`.

### Step 3: Add Activity Pydantic models

**File**: `financial_forecasting/models.py`

Follow existing pattern: `BaseModel`, `alias=` for SF fields, `allow_population_by_field_name = True`.

```python
class ActivityType(str, Enum):
    CALL = "call"
    EMAIL = "email"
    MEETING = "meeting"
    NOTE = "note"
    SLACK_MESSAGE = "slack-message"
    CALENDAR_EVENT = "calendar-event"

class ActivitySource(str, Enum):
    SALESFORCE = "salesforce"
    EXTENSION = "extension"
    MANUAL = "manual"
    GMAIL_SYNC = "gmail-sync"
    CALENDAR_SYNC = "calendar-sync"

class Activity(BaseModel):
    id: Optional[str] = None
    sf_id: Optional[str] = None
    sf_type: Optional[str] = None
    type: ActivityType
    subject: str
    description: Optional[str] = None
    description_html: Optional[str] = None
    activity_date: datetime
    opportunity_id: Optional[str] = None
    account_id: Optional[str] = None
    contact_ids: List[str] = []
    task_id: Optional[str] = None
    source: ActivitySource
    source_ref: Optional[str] = None
    source_thread_id: Optional[str] = None
    logged_by: Optional[str] = None
    owner_id: Optional[str] = None
    # Email fields
    email_from: Optional[str] = None
    email_to: Optional[List[str]] = None
    email_cc: Optional[List[str]] = None
    email_snippet: Optional[str] = None
    # Meeting fields
    meeting_duration_minutes: Optional[int] = None
    meeting_attendees: Optional[List[dict]] = None
    meeting_location: Optional[str] = None
    # Attachments
    attachments: Optional[List[dict]] = None
    # Sync status
    sf_sync_status: Optional[str] = "synced"

    class Config:
        allow_population_by_field_name = True
```

### Step 4: SF Activity sync (Tasks + Events)

**File**: `financial_forecasting/data_sync.py` — extend existing sync service

Add to `DataSyncService`:

```python
async def sync_activities(self):
    """Sync SF Tasks + Events into bedrock.activity table."""
    # Phase 1: Initial bulk sync (first run — no last_sync timestamp)
    # Phase 2: Incremental sync (subsequent runs, LastModifiedDate filter)
```

**SOQL queries to add**:

```sql
-- Tasks (extend existing query to include all fields)
SELECT Id, Subject, Status, Priority, ActivityDate, Description,
       OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
       Type, TaskSubtype, CreatedById, CreatedBy.Name,
       CreatedDate, LastModifiedDate, IsClosed,
       CallType, CallDurationInSeconds
FROM Task
WHERE LastModifiedDate > {last_sync_timestamp}
ORDER BY LastModifiedDate ASC

-- Events (NEW — not currently synced)
SELECT Id, Subject, Description, StartDateTime, EndDateTime,
       OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
       Type, Location, DurationInMinutes, IsAllDayEvent,
       CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
FROM Event
WHERE LastModifiedDate > {last_sync_timestamp}
ORDER BY LastModifiedDate ASC
```

**Sync logic**:
1. Query SF with `LastModifiedDate > last_sync` (or no filter for first run)
2. Use `queryMore` cursor for pagination (SF 2000-record batches)
3. Map SF Task → `activity` row with `sf_type='Task'`, `source='salesforce'`
4. Map SF Event → `activity` row with `sf_type='Event'`, `source='salesforce'`
5. UPSERT by `sf_id` (insert or update if exists)
6. Resolve `account_id` from Opportunity's `AccountId` when `WhatId` is an Opportunity
7. Store `last_sync_timestamp` for next incremental run

**Wire into existing sync loop**: Add `await self.sync_activities()` call in `sync_all_data()`.

### Step 5: Activity CRUD endpoints

**File**: `financial_forecasting/routes/activities.py` (NEW)

Follow existing router pattern: `APIRouter(tags=["activities"])`, `Depends(get_mcp_client)`, `Depends(require_auth)`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/activities` | GET | List activities with filters (opportunity_id, account_id, contact_id, type, date range) |
| `GET /api/activities/{id}` | GET | Get single activity by UUID |
| `GET /api/activities/search` | GET | Full-text search (`to_tsquery`) with scoped and global modes |
| `POST /api/activities` | POST | Create activity (from extension or manual). Write-through: create in Bedrock → push to SF as Task |
| `PUT /api/activities/{id}` | PUT | Update activity |
| `DELETE /api/activities/{id}` | DELETE | Soft-delete (set `deleted_at`, never hard delete per entity-map) |
| `POST /api/activities/sync/trigger` | POST | Manual sync trigger (admin-only) |
| `GET /api/activities/sync/status` | GET | Sync status (last run, record counts, errors) |
| `GET /api/activities/match-context` | GET | Smart Contact matching for extension (email → domain → name) |
| `POST /api/activities/insights` | POST | On-demand AI insights generation (click-to-generate, cached) |

**Write-through to SF** (for new activities from extension/manual):
1. Insert into `bedrock.activity` → immediate local availability
2. Background task: create SF Task via `salesforce.Task.create({...})`
3. On success: update `bedrock.activity.sf_id` with returned SF Id
4. On failure: log error, mark `sf_sync_status = 'pending'`, retry next cycle

**SF Task field mapping** (Bedrock → SF):
- `Subject` = activity.subject
- `Description` = activity.description (truncated to SF limit 32,000 chars)
- `WhatId` = activity.opportunity_id
- `WhoId` = activity.contact_ids[0] (primary contact)
- `ActivityDate` = activity.activity_date
- `Type` = mapped from activity.type ('Email', 'Call', 'Meeting')
- `Status` = 'Completed'

### Step 6: GCS attachment storage

**Integration point**: Google Cloud Storage (project already uses GCP)

```python
from google.cloud import storage

async def upload_attachment(activity_id: str, filename: str, content: bytes, mime_type: str) -> str:
    """Upload attachment to GCS, return URL."""
    bucket = storage.Client().bucket(GCS_BUCKET)
    blob_path = f"activities/{datetime.now().year}/{activity_id}/{filename}"
    blob = bucket.blob(blob_path)
    blob.upload_from_string(content, content_type=mime_type)
    return f"gs://{GCS_BUCKET}/{blob_path}"
```

**Fake attachment filtering**:
- Skip `Content-Disposition: inline` (signature images)
- Skip files < 1KB (tracking pixels)
- Skip MIME types: `application/pkcs7-signature`, `text/calendar`, `application/pgp-signature`
- Keep `Content-Disposition: attachment` with real MIME types

**Size limits**: 25MB per file, 50MB per activity. Extension warns before upload.

### Step 7: Thread-aware email storage

When creating an Activity from an email:
1. Check `source_thread_id` — does this thread have any existing Activities?
2. If yes, fetch all messages in the Gmail thread via `threads.get(threadId)`
3. Find messages after the last logged `source_ref` (gmail_message_id)
4. Create Activity records for each unsaved reply + the current message
5. Return count to caller: "Logging 3 messages (2 unsaved replies + this email)"

### Step 8: Register router and test

**File**: `financial_forecasting/main.py`
- Add `from routes.activities import router as activities_router`
- Add `app.include_router(activities_router)`

**Tests**: Endpoint tests for all CRUD operations, sync logic tests, search tests.

---

## Sprint 9B: Activity Timeline + Detail Modals (Frontend)

### Step 1: Add Activity TypeScript types

**File**: `financial_forecasting/frontend/src/types/salesforce.ts`

```typescript
export interface Activity {
    id: string;
    sf_id: string | null;
    sf_type: 'Task' | 'Event' | null;
    type: 'call' | 'email' | 'meeting' | 'note' | 'slack-message' | 'calendar-event';
    subject: string;
    description: string | null;
    description_html: string | null;
    activity_date: string;
    opportunity_id: string | null;
    account_id: string | null;
    contact_ids: string[];
    task_id: string | null;
    source: 'salesforce' | 'extension' | 'manual' | 'gmail-sync' | 'calendar-sync';
    source_ref: string | null;
    email_from: string | null;
    email_to: string[] | null;
    email_cc: string[] | null;
    email_snippet: string | null;
    meeting_duration_minutes: number | null;
    meeting_attendees: Array<{name: string; email: string; status: string}> | null;
    meeting_location: string | null;
    attachments: Array<{name: string; size: number; mime: string; gcs_url: string}> | null;
    logged_by: string | null;
    created_at: string;
}

export interface ActivityInsights {
    summary: string;
    key_findings: string[];
    action_items: string[];
    momentum: 'hot' | 'warm' | 'cold' | 'new';
    generated_at: string;
}
```

### Step 2: Add Activity API methods

**File**: `financial_forecasting/frontend/src/services/api.ts`

```typescript
// Activities
getActivities: (params: {
    opportunity_id?: string;
    account_id?: string;
    contact_id?: string;
    type?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
}) => api.get('/api/activities', { params }),

searchActivities: (params: {
    q: string;
    scope?: 'global' | 'opportunity' | 'account' | 'contact';
    scope_id?: string;
    months?: number;
    limit?: number;
}) => api.get('/api/activities/search', { params }),

createActivity: (data: Partial<Activity>) =>
    api.post('/api/activities', data),

generateActivityInsights: (params: {
    opportunity_id?: string;
    account_id?: string;
}) => api.post('/api/activities/insights', params, { timeout: 60000 }),
```

### Step 3: Build ActivityTimeline component

**File**: `financial_forecasting/frontend/src/components/ActivityTimeline.tsx` (NEW)

**Props**:
```typescript
interface ActivityTimelineProps {
    opportunityId?: string;
    accountId?: string;
    contactId?: string;
    accountName?: string;  // For context display
}
```

**Sections**:
1. **AI Insights header** (collapsed by default, click "Generate Insights" to populate)
   - Momentum badge (hot/warm/cold/new)
   - Summary text, key findings, action items
   - Cached until user clicks "Regenerate"
   - Cost: ~$0.003-0.005 per generation (Claude Haiku)
2. **Search + filter bar**
   - Text search input
   - Type filter dropdown (All, Emails, Meetings, Calls, Notes)
   - Date range filter (default: last 12 months, expandable)
3. **Chronological timeline**
   - Grouped by date (Today, Yesterday, This Week, This Month, Older)
   - Each item shows: type icon, subject, participants, timestamp, source badge
   - Email items: expandable body, attachment chips with download links
   - Meeting items: duration, attendees with RSVP status, location
   - Task link badge if linked to a Task (click to view Task)
4. **Load more** pagination (explicit button, not infinite scroll)

**Data fetching**: React Query with `staleTime: 5 minutes`, `cacheTime: 30 minutes`.

### Step 4: Build Opportunity detail modal

**File**: `financial_forecasting/frontend/src/components/OpportunityDetailModal.tsx` (NEW)

Replicate `Accounts.tsx` detail modal pattern exactly:
- MUI `Dialog` with `maxWidth="lg"` and `fullWidth`
- State: `open` boolean, `opportunity` object
- Header: Opportunity Name, Stage chip, Amount, Close Date, Owner, [Edit] button
- Summary cards row: Total Activities, Open Tasks, Contacts, Payments

**Tabs**:
1. **Activities** — `<ActivityTimeline opportunityId={opp.Id} accountName={opp.Account?.Name} />`
2. **Tasks** — Reuse existing TaskPanel content (extract into shared component)
3. **Contacts** — Contacts related to this Opportunity's Account
4. **Payments** — Payment schedule (existing endpoint)
5. **Details** — Key fields display, Edit button opens existing `OpportunityEditDialog`

**Trigger**: Click on Opportunity Name in the DataGrid (like Accounts page does).

**Does NOT replace**: Existing TaskPanel drawer and ActivityIntelligencePanel drawer remain functional.

### Step 5: Build Contact detail modal

**File**: `financial_forecasting/frontend/src/components/ContactDetailModal.tsx` (NEW)

Same MUI Dialog pattern:
- Header: Contact Name, Title, Email, Phone, Primary Affiliation, [Edit] button
- Summary cards: Total Activities, Related Opportunities

**Tabs**:
1. **Activities** — `<ActivityTimeline contactId={contact.Id} />`
2. **Opportunities** — Opportunities where this Contact appears
3. **Details** — Key fields, Edit button opens existing `ContactEditDialog`

**Trigger**: Click on Contact Name in the DataGrid.

### Step 6: Add Activities tab to Accounts detail modal

**File**: `financial_forecasting/frontend/src/pages/Accounts.tsx`

Add tab 7 to existing detail modal (after Fireflies Meetings tab):
- Label: `Activities ({count})`
- Content: `<ActivityTimeline accountId={selectedAccount.Id} accountName={selectedAccount.Name} />`
- Existing 6 tabs remain untouched

### Step 7: Test in isolation

Before wiring into real pages, test ActivityTimeline on a dev route:
- Add `/dev/activity-timeline` route (dev-only, removed before merge)
- Verify rendering with real synced data from Sprint 9A
- Test search, filtering, pagination, AI insights generation
- Test responsive layout at different modal widths

---

## Sprint 9C: Chrome Extension

### Architecture

```
extension/
├── manifest.json           # Manifest V3
├── background/
│   └── service-worker.js   # Background service worker
├── content/
│   ├── gmail.js            # Gmail content script (detects open email)
│   └── gcal.js             # GCal content script (detects open event)
├── popup/
│   ├── index.html          # Popup shell
│   ├── App.tsx             # React popup app
│   ├── components/
│   │   ├── OppPicker.tsx       # Opportunity search + suggestions
│   │   ├── TaskLinker.tsx      # Open Tasks for selected Opp
│   │   ├── CascadeFlow.tsx     # No-match cascade
│   │   ├── ThreadPreview.tsx   # Shows unsaved thread replies
│   │   └── AttachmentList.tsx  # Filtered attachments with size
│   └── services/
│       └── bedrockApi.ts   # API client for Bedrock backend
├── shared/
│   └── types.ts            # Shared TypeScript types
└── icons/                  # Extension icons (16, 32, 48, 128px)
```

### Step 1: Manifest V3 setup

```json
{
    "manifest_version": 3,
    "name": "Bedrock CRM",
    "version": "1.0.0",
    "permissions": ["activeTab", "storage", "identity"],
    "host_permissions": [
        "https://mail.google.com/*",
        "https://calendar.google.com/*",
        "http://localhost:8000/*"
    ],
    "content_scripts": [
        {
            "matches": ["https://mail.google.com/*"],
            "js": ["content/gmail.js"]
        },
        {
            "matches": ["https://calendar.google.com/*"],
            "js": ["content/gcal.js"]
        }
    ],
    "action": { "default_popup": "popup/index.html" },
    "background": { "service_worker": "background/service-worker.js" }
}
```

### Step 2: Content scripts

**Gmail content script** (`content/gmail.js`):
- Detect when user has an email open (observe DOM for email view container)
- Extract: subject, from, to, cc, date from the visible email header
- Extract: Gmail message ID from the URL hash
- Send to popup via `chrome.runtime.sendMessage`
- Does NOT read email body (OAuth does that server-side)

**GCal content script** (`content/gcal.js`):
- Detect when user has an event open (event detail panel)
- Extract: event title, date/time, attendees from visible DOM
- Send to popup via `chrome.runtime.sendMessage`

### Step 3: Popup UI — Opportunity-first cascade flow

**Normal flow (auto-match found)**:
1. Content script sends email/event context to popup
2. Popup calls `GET /api/activities/match-context` with sender email + subject
3. Backend matches sender email → Contact → related Opportunities
4. Popup shows Opportunity suggestions + search bar (hits `/api/salesforce/search`)
5. User picks Opp → popup shows open Tasks for that Opp (optional link)
6. User clicks "Log" → `POST /api/activities` with full context

**Cascade flow (no auto-match)**:
1. No Opportunities matched → informational popover encouraging manual search
2. User searches via search bar → finds Opp → normal flow
3. User can't find Opp → "Should this be a new Opportunity?" prompt
4. User clicks "Create Opportunity" → minimal form (Name, Account, Stage) → creates Opp → logs Activity
5. User clicks "Not yet" → falls back to Account picker, then Contact picker

### Step 4: Smart Contact matching endpoint

**Endpoint**: `GET /api/activities/match-context`

**Matching tiers**:
- **Tier 1 (high confidence)**: Exact email address match → Contact
- **Tier 2 (medium confidence)**: Email domain matches Account website domain → suggest Account's Contacts by name similarity
- **Tier 3 (low confidence)**: Name fuzzy match only → show as "possible match, confirm?"

For matched Contacts, pull related open Opportunities (not Accounts). Opportunity gives unambiguous Account resolution (critical for Contacts with dual affiliations — e.g., Individual/Household account AND Org account).

### Step 5: Thread gap detection

When logging an email:
1. Extension sends `gmail_thread_id` to backend
2. Backend queries: `SELECT source_ref FROM bedrock.activity WHERE source_thread_id = ? ORDER BY activity_date DESC LIMIT 1`
3. If previous message found, call Gmail API: `threads.get(threadId)`
4. Find all messages between last logged and current
5. Return to extension: "This will log 3 messages (2 unsaved replies + this email)"
6. User confirms → backend creates all Activity records

### Step 6: Attachment handling

1. Extension shows real attachments (filtered, with sizes)
2. User confirms → `POST /api/activities` includes `attachment_refs: [{gmail_msg_id, attachment_id, name, size, mime}]`
3. Backend downloads from Gmail API: `messages.attachments.get(messageId, attachmentId)`
4. Filters fake attachments (inline, <1KB, signature MIME types)
5. Uploads to GCS, stores URLs in Activity record
6. If file > 25MB: return error to extension, extension shows warning

### Step 7: Write-through to Salesforce

After creating Activity in Bedrock, background task pushes to SF as Task.
On success: update `activity.sf_id`. On failure: mark `sf_sync_status = 'pending'`, retry next cycle.

---

## Sprint 9D: Integration + QA (Worktree for Safety)

### Step 1: Create worktree

```bash
git worktree add ../bedrock-integration-test feat/sprint-9d-integration
```

All integration work happens in the worktree. Main branch stays untouched until proven.

### Step 2: Wire Opportunity detail modal

**File**: `financial_forecasting/frontend/src/pages/Opportunities.tsx`

- Import `OpportunityDetailModal`
- Add state: `detailModalOpen`, `detailOpp`
- Add click handler on Opportunity Name column (like Accounts does)
- Render modal
- Existing TaskPanel drawer and ActivityIntelligencePanel drawer remain unchanged

### Step 3: Wire Contact detail modal

**File**: `financial_forecasting/frontend/src/pages/Contacts.tsx`

- Import `ContactDetailModal`
- Add state: `detailModalOpen`, `detailContact`
- Add click handler on Contact Name column
- Render modal
- Existing edit dialog remains unchanged

### Step 4: Add Activities to Global Search

Extend existing Global Search (Session 6) to include Activity results.
- Query: `GET /api/activities/search?q={query}&scope=global&months=12&limit=5`
- Display: Activity subject, type icon, linked Opportunity name, date
- Click → opens parent entity's detail modal with Activities tab focused

### Step 5: Regression testing

**Existing functionality preserved**:
- [ ] Opportunities DataGrid renders correctly
- [ ] Task Panel drawer opens/closes
- [ ] Activity Intelligence panel opens/closes with all 5 source tabs
- [ ] Account detail modal works with all 6 existing tabs
- [ ] Contact edit dialog works
- [ ] Global Search returns Opportunities, Accounts, Contacts
- [ ] Inline editing on all entities works
- [ ] Notification center works

**New functionality works**:
- [ ] Clicking Opportunity Name opens detail modal with 5 tabs
- [ ] Activities tab shows chronological timeline with synced SF data
- [ ] Activity search (scoped) returns results within entity
- [ ] "Generate Insights" button triggers AI analysis, results display
- [ ] Clicking Contact Name opens detail modal with 3 tabs
- [ ] Account detail modal has 7th Activities tab
- [ ] Global Search returns Activity results
- [ ] Chrome extension logs email → appears in timeline within seconds
- [ ] Extension thread detection catches unsaved replies
- [ ] Attachments upload to GCS and display in timeline
- [ ] SF write-through creates Task in Salesforce
- [ ] Activity-Task linking works (optional, marks Task complete)

**Edge cases**:
- [ ] Opportunity with zero Activities shows empty state
- [ ] Activity with no Opportunity (Account-only) displays correctly
- [ ] Large attachment (>25MB) shows warning in extension
- [ ] Gmail thread with 20+ messages handles pagination
- [ ] SF sync handles deleted Activities (soft delete in Bedrock)
- [ ] Extension works when Bedrock backend is unreachable (graceful error)

### Step 6: Merge to main

Only after all regression tests pass. Create PR for review.

---

## Key Files Summary

### New files to create
| File | Sprint | Purpose |
|------|--------|---------|
| `financial_forecasting/routes/activities.py` | 9A | Activity CRUD + search + sync endpoints |
| `financial_forecasting/frontend/src/components/ActivityTimeline.tsx` | 9B | Chronological activity timeline |
| `financial_forecasting/frontend/src/components/OpportunityDetailModal.tsx` | 9B | Opportunity detail modal (like Accounts) |
| `financial_forecasting/frontend/src/components/ContactDetailModal.tsx` | 9B | Contact detail modal |
| `extension/` directory (all files) | 9C | Chrome extension |

### Existing files to modify
| File | Sprint | Change |
|------|--------|--------|
| `financial_forecasting/db/init.sql` | 9A | Add `activity` table + indexes + triggers |
| `financial_forecasting/models.py` | 9A | Add Activity model + enums |
| `financial_forecasting/data_sync.py` | 9A | Add SF Task + Event sync |
| `financial_forecasting/main.py` | 9A | Register activities router |
| `financial_forecasting/frontend/src/types/salesforce.ts` | 9B | Add Activity interface |
| `financial_forecasting/frontend/src/services/api.ts` | 9B | Add Activity API methods |
| `financial_forecasting/frontend/src/pages/Accounts.tsx` | 9D | Add 7th Activities tab |
| `financial_forecasting/frontend/src/pages/Opportunities.tsx` | 9D | Add detail modal trigger |
| `financial_forecasting/frontend/src/pages/Contacts.tsx` | 9D | Add detail modal trigger |

### Files NOT modified (preserved as-is)
| File | Why |
|------|-----|
| `ActivityIntelligencePanel.tsx` | Existing panel stays functional, not replaced |
| `TaskPanel` components | Drawer continues working alongside modal |
| `OpportunityEditDialog` | Edit dialog used inside new detail modal |
| `ContactEditDialog` | Edit dialog used inside new detail modal |
| `AccountEditDialog` | Edit dialog used inside Accounts detail modal |
| All existing routes | No modifications to existing endpoints |

---

## Verification Plan

### Sprint 9A
```bash
# 1. Run database migration
python -c "from financial_forecasting.db import init_db; import asyncio; asyncio.run(init_db())"

# 2. Verify table exists
psql -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'activity' ORDER BY ordinal_position;"

# 3. Trigger sync
curl -X POST http://localhost:8000/api/activities/sync/trigger -H "Authorization: Bearer $TOKEN"

# 4. Verify data
curl http://localhost:8000/api/activities?limit=10 -H "Authorization: Bearer $TOKEN"

# 5. Test search
curl "http://localhost:8000/api/activities/search?q=grant+proposal&scope=global" -H "Authorization: Bearer $TOKEN"

# 6. Run tests
pytest financial_forecasting/tests/test_activities.py -v
```

### Sprint 9B
- Start frontend dev server, navigate to `/dev/activity-timeline`
- Verify timeline renders with real synced data
- Test search, filtering, pagination, AI insights generation

### Sprint 9C
- Load unpacked extension in Chrome (`chrome://extensions`)
- Open Gmail with email from known Contact
- Verify Opportunity suggestions appear
- Log email → verify it appears in Bedrock + Salesforce
- Test attachments, thread detection, cascade flow

### Sprint 9D
- Full regression checklist
- Side-by-side comparison: worktree vs main
- Team member UAT before merge
