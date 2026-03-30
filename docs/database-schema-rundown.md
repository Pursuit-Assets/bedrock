# Database Schema Rundown

> Created: 2026-03-25 | Meeting with senior devs
> Production DB: `segundo-db` on GCP (34.57.101.141:5432), role `bedrock_user`, schema `bedrock`

## Production Database Model

- **Database**: `segundo-db` (shared Pursuit platform DB, 136+ tables in `public`)
- **Schema**: `bedrock` (owned by `postgres`, `bedrock_user` has CREATE + USAGE)
- **Role**: `bedrock_user` — read-only on `public.*`, write on `bedrock.*`
- **Convention**: All SQL is schema-qualified (`bedrock.project`, `bedrock.pebble_profiles`)

---

## 1. BEDROCK — Salesforce is the backend, few exceptions

Bedrock reads/writes Salesforce for CRM data. The **exceptions** live in our `bedrock` schema:

### `bedrock.permission_profile`
Roles with JSONB permission flags. Salesforce has no equivalent.
```
id              UUID PK
name            TEXT UNIQUE        -- 'Admin', 'Fundraiser', 'Manager'
description     TEXT
is_default      BOOLEAN
permissions     JSONB              -- 26 boolean keys (view/edit/create per feature)
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```
Seeded with 3 profiles on init.

### `bedrock.app_user`
Local user directory linking Google login to permissions + optional SF user.
```
id              UUID PK
sf_user_id      TEXT UNIQUE NULL   -- links to SF User record (optional)
email           TEXT UNIQUE        -- from Google OAuth
name            TEXT
profile_id      UUID FK -> permission_profile
is_active       BOOLEAN
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```
Auto-provisioned on first Google OAuth login.

### `bedrock.opportunity_lock`
Pessimistic locking when someone opens an Opportunity edit dialog.
```
sf_opportunity_id   TEXT PK        -- Salesforce Opportunity ID
locked_by           TEXT           -- user email
locked_at           TIMESTAMPTZ
```

### What Bedrock reads FROM Salesforce (no local tables needed)
- **Opportunities** -- Id, Name, Amount, StageName, CloseDate, Payment_Terms__c, Invoice_Status__c, etc.
- **Accounts** -- Id, Name, Billing fields, Intacct_Customer_ID__c
- **Contacts** -- via Pebble's CRM bridge
- **Tasks** -- fetched on demand via SF API
- **npe01__OppPayment__c** -- NPSP payment records
- **OpportunityFieldHistory** -- stage change tracking

### What Bedrock writes TO Salesforce (no local tables needed)
- **Opportunity fields**: Invoice_Status__c, Intacct_Invoice_ID__c, Invoice_Date__c, Payment_Status__c, Payment_Date__c, Payment_Amount__c
- **Account fields**: Intacct_Customer_ID__c, Total_Outstanding__c, Credit_Limit__c, Last_Financial_Update__c
- **Invoice__c** (custom object): created when invoicing an opportunity
- **npe01__OppPayment__c**: links payment to Invoice__c

### 1.5 Activities — Local mirror of SF Tasks + Events

Activities synced from Salesforce Tasks and Events into a local PostgreSQL table. Also supports manual entries and Chrome extension entries.

### `bedrock.activity`
```
id                      UUID PK
sf_id                   TEXT UNIQUE           -- Salesforce Task/Event ID (mirror sync)
sf_type                 TEXT                  -- 'Task' or 'Event'
type                    TEXT NOT NULL         -- 'call'|'email'|'meeting'|'note'|'slack-message'|'calendar-event'
subject                 TEXT NOT NULL
description             TEXT
description_html        TEXT
activity_date           TIMESTAMPTZ NOT NULL
opportunity_id          TEXT                  -- SF Opportunity ID (association)
account_id              TEXT                  -- SF Account ID
contact_ids             TEXT[]                -- SF Contact IDs
project_task_id         UUID FK -> project_task (SET NULL)
sf_task_id              TEXT                  -- SF Task ID linked when logging
source                  TEXT NOT NULL         -- 'salesforce'|'extension'|'manual'|'gmail-sync'|'calendar-sync'
source_ref              TEXT
source_thread_id        TEXT                  -- email thread grouping
email_from              TEXT
email_to                TEXT[]
email_cc                TEXT[]
email_snippet           TEXT
meeting_duration_minutes INTEGER
meeting_attendees       JSONB
meeting_location        TEXT
attachments             JSONB DEFAULT '[]'    -- GCS URLs (extension, M15)
logged_by               TEXT
owner_id                TEXT
sf_last_modified        TIMESTAMPTZ           -- sync watermark
synced_at               TIMESTAMPTZ
sf_sync_status          TEXT DEFAULT 'synced' -- 'synced'|'pending'|'failed'
search_vector           TSVECTOR              -- FTS: subject(A), snippet(B), description(C)
deleted_at              TIMESTAMPTZ           -- soft delete (prevents sync resurrection)
created_at              TIMESTAMPTZ
updated_at              TIMESTAMPTZ
```

Key features: soft delete, full-text search with weighted fields, 11 indexes including partial index on non-deleted rows.

---

## 2. PROJECT TRACKING — Local-first with SF bridges

Projects/tasks/milestones are local (PostgreSQL), with bridge tables linking SF objects.

### `bedrock.project`
```
id              UUID PK
name            TEXT
description     TEXT
opportunity_id  TEXT NULL          -- optional link to SF Opportunity
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
deleted_at      TIMESTAMPTZ           -- soft delete (M18)
deleted_by      TEXT                  -- audit: who deleted
```

### `bedrock.workstream`
```
id              UUID PK
project_id      UUID FK -> project (CASCADE — retained for admin purge; app uses soft-delete)
name            TEXT
description     TEXT
sort_order      INT
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
deleted_at      TIMESTAMPTZ           -- soft delete (M18, cascade from project)
deleted_by      TEXT
```

### `bedrock.milestone`
```
id              UUID PK
workstream_id   UUID FK -> workstream (CASCADE — retained for admin purge; app uses soft-delete)
title           TEXT
status          TEXT CHECK ('On Track'|'At Risk'|'Needs Attention'|'Completed')
priority        TEXT CHECK ('Now'|'Later'|'On-going')
owner           TEXT               -- free text, not FK'd to app_user
description     TEXT
source_links    TEXT[]
sort_order      INT
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
deleted_at      TIMESTAMPTZ           -- soft delete (M18, cascade from workstream)
deleted_by      TEXT
```

### `bedrock.project_task`
```
id              UUID PK
milestone_id    UUID FK -> milestone (CASCADE — retained for admin purge; app uses soft-delete)
title           TEXT
status          TEXT CHECK ('Not Started'|'In Progress'|'Completed'|'Blocked'|'On Hold')
owner           TEXT               -- free text
deadline        DATE
start_date      DATE               -- for Gantt chart
description     TEXT
updates         TEXT
links           TEXT[]
depends_on      UUID[]             -- references other project_task.id
sort_order      INT
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
deleted_at      TIMESTAMPTZ           -- soft delete (M18, cascade from milestone)
deleted_by      TEXT
```

### `bedrock.sf_task_dependency`
SF Tasks don't support native dependencies. Stored locally.
```
id              UUID PK
task_id         TEXT               -- Salesforce Task ID (00T...)
depends_on_id   TEXT               -- Salesforce Task ID
external_source TEXT DEFAULT 'salesforce'
created_at      TIMESTAMPTZ
UNIQUE (task_id, depends_on_id)
```

### `bedrock.sf_task_project`
Bridge: SF Tasks appear inside local project views.
```
id              UUID PK
sf_task_id      TEXT UNIQUE        -- Salesforce Task ID
external_source TEXT DEFAULT 'salesforce'
project_id      UUID FK -> project (CASCADE)
milestone_id    UUID FK -> milestone (SET NULL)
sort_order      INT
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

### `bedrock.project_opportunity`
Many-to-many link between Projects and CRM Opportunities. Supports multi-Opportunity campaigns.
```
project_id      UUID FK -> project (CASCADE)
opportunity_id  TEXT NOT NULL
role            TEXT DEFAULT 'linked'
created_at      TIMESTAMPTZ
UNIQUE (project_id, opportunity_id)
```

---

## 3. PEBBLE — New tables (fresh start, `pebble_` prefix)

All tables in `bedrock` schema with `pebble_` prefix. Created fresh (no SQLite data migration).

### `bedrock.pebble_profiles` -- Final research output per contact
```
contact_id      TEXT PK            -- Salesforce Contact ID
profile_json    TEXT               -- JSON: claims[], summary, confidence_score
cost_usd        NUMERIC
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_research_sessions` -- One row per completed research run
```
id              UUID PK DEFAULT uuid_generate_v4()
contact_id      TEXT               -- indexed
profile_json    TEXT
cost_usd        NUMERIC
prospect_name   TEXT
prospect_org    TEXT
status          TEXT DEFAULT 'completed'
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_feedback` -- Claim accuracy tracking
```
id              UUID PK DEFAULT uuid_generate_v4()
claim_id        TEXT
correct         BOOLEAN
text            TEXT NULL
contact_id      TEXT NULL
user_id         TEXT NULL
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_harness_log` -- Agent execution metrics
```
id              UUID PK DEFAULT uuid_generate_v4()
agent_name      TEXT
outcome         TEXT               -- success|failure|escalated
cost_usd        NUMERIC
tokens_input    INTEGER
tokens_output   INTEGER
attempts        INTEGER
elapsed_seconds NUMERIC
error           TEXT NULL
prospect_id     TEXT NULL
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_source_scores` -- Stigmergy pheromone trail
```
id              UUID PK DEFAULT uuid_generate_v4()
source_name     TEXT
richness_score  NUMERIC
prospect_id     TEXT NULL
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_api_cache` -- Response deduplication with TTL
```
id              UUID PK DEFAULT uuid_generate_v4()
source          TEXT
lookup_key      TEXT
response_json   TEXT
created_at      TIMESTAMPTZ DEFAULT now()
expires_at      TIMESTAMPTZ NULL
UNIQUE (source, lookup_key)
```

### `bedrock.pebble_chat_conversations` -- Ask Pebble sessions
```
id              UUID PK
user_email      TEXT
title           TEXT NULL
total_cost_usd  NUMERIC DEFAULT 0.0
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_chat_messages` -- Chat message history
```
id              UUID PK
conversation_id UUID FK -> pebble_chat_conversations
role            TEXT               -- 'user' or 'assistant'
content         TEXT
tier            TEXT NULL          -- T0, T0.5, T1, T2, T3
cost_usd        NUMERIC DEFAULT 0.0
metadata_json   TEXT NULL
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_research_batches` -- Bulk research jobs
```
id              UUID PK
user_email      TEXT
total_prospects INTEGER DEFAULT 0
completed_prospects INTEGER DEFAULT 0
target_tier     TEXT DEFAULT 'T1'
status          TEXT DEFAULT 'pending'
total_cost_usd  NUMERIC DEFAULT 0.0
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_batch_prospects` -- Individual prospects in a batch
```
id              UUID PK
batch_id        UUID FK -> pebble_research_batches
prospect_name   TEXT
prospect_org    TEXT
current_tier    TEXT DEFAULT 'pending'
identity_confidence TEXT DEFAULT 'none'
crm_status      TEXT DEFAULT 'unknown'
result_json     TEXT NULL
cost_usd        NUMERIC DEFAULT 0.0
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_conflict_log` -- NEW: Persist detected conflicts
```
id              UUID PK DEFAULT uuid_generate_v4()
session_id      UUID FK -> pebble_research_sessions
contact_id      TEXT
conflict_type   TEXT               -- 'role'|'financial'|'temporal'
claim_a         TEXT
claim_b         TEXT
description     TEXT
resolution      TEXT NULL
created_at      TIMESTAMPTZ DEFAULT now()
```

### `bedrock.pebble_scratchpad` -- NEW: Persist intermediate research state
```
id              UUID PK DEFAULT uuid_generate_v4()
session_id      UUID FK -> pebble_research_sessions
contact_id      TEXT
scratchpad_json TEXT               -- full ResearchScratchpad + ProspectResearchContext
status          TEXT               -- 'active'|'completed'|'failed'|'timeout'
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```

---

## Data Flow: Pebble <-> Salesforce

| Data | Destination | Method | Status |
|---|---|---|---|
| New Account | Salesforce | CRM bridge POST | Working |
| New Contact | Salesforce | CRM bridge POST | Working |
| New Opportunity | Salesforce | CRM bridge POST | Working |
| Update existing Contact/Account fields | Salesforce | CRM bridge PATCH | NOT YET BUILT (Sprint 11) |
| Full research profile | Our DB (pebble_profiles) | Direct insert | Working |
| Session history | Our DB (pebble_research_sessions) | Direct insert | Working |

---

## Decisions Made (2026-03-25)

- **Schema-qualify all SQL** -- Every table reference uses `bedrock.table_name`. 93 existing SQL statements across 7 files need prefixing (Sprint 9).
- **Shared DB, `pebble_` prefix** -- e.g., `bedrock.pebble_profiles`
- **Fresh start** -- No SQLite data migration. Create empty PostgreSQL tables.
- **Persist conflict logs + scratchpads** -- For audit trail, debugging, and multi-worker scaling.
- **Pebble should UPDATE existing SF records** -- RESOLVED in M17: CRM bridge update methods added; field definitions obtained from SF describe() audit.

### Prospect CRM Mapping Tables (M17)

Five new tables added in M17 to support the Pebble prospect → CRM conversion pipeline:

| Table | Purpose |
|-------|---------|
| `bedrock.sf_field_requirements` | Reference table: SF field metadata from describe() audit. Tracks which fields are required, their types, defaults, and which Pebble tier can populate them. |
| `bedrock.prospect_sf_contact` | Typed columns mapping prospect research to SF Contact fields (last_name, first_name, title, email, etc.). All nullable for soft enforcement. |
| `bedrock.prospect_sf_account` | Typed columns mapping prospect research to SF Account fields (name, industry, type, grantmaker, etc.). |
| `bedrock.prospect_sf_opportunity` | Research-derived opportunity hints (suggested_name, giving_capacity_estimate, wealth_indicators, etc.). |
| `bedrock.sf_schema_drift_log` | Tracks detected changes between SF describe() and sf_field_requirements. HITL review before schema updates. |

**Design**: All prospect columns nullable. Readiness computed at read time by checking populated fields against `sf_field_requirements`. Updated-at triggers on all three prospect tables.

Full audit documentation: `product/reference/salesforce-required-fields.md`

## Sprint Roadmap

See `docs/PLAN-INDEX.md` for current milestone status and execution order.

```
✅ M9:  Complete Database Schema Deployment (bedrock. prefix + all new DDL)
✅ M10: Activities Foundation (backend endpoints + sync)
✅ M11: Pebble PostgreSQL Migration (SQLite → asyncpg)
✅ M12: Pebble Access Control (RBAC + cost limits)
   M13: Activities Timeline + Modals — 2 sessions (frontend, depends M10)
   M15: Chrome Extension — 2 sessions (depends M10, parallel with M13)
   M16: Integration + QA — 1 session (depends M13 + M15)
🔧 M17: SF Audit + Prospect CRM Mapping — 3 sessions (absorbs M14)
        Session 1 ✅: Schema + validation + storage
        Session 2: T1-T3 pipeline + persistence
        Session 3: Drift detection + integration test
✅ M18: Project Soft-Delete
   M19: Project Ownership Model — 1 session (depends M18)
```

Note: Pebble stays Python/FastAPI (performance + security advantages for I/O-bound LLM workload). PRD Node.js references are about the target Pursuit platform, not Pebble.
