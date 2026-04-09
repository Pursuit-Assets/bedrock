# Spec: Identity Consolidation — Contact Bridge + Staff Identity Cleanup

> Status: Draft
> Author: Jac
> Date: 2026-04-09

## Goal

Two changes to finish the cross-schema identity layer:
1. **Contact bridge** — link SF Contacts to `public.contacts` (same pattern as `sf_account_company_map`)
2. **Staff identity consolidation** — make `public.org_users` the single canonical staff table, replace `bedrock.app_user` with a thin config table

---

## 1. Contact Bridge: `bedrock.sf_contact_map`

### Why

`sf_account_company_map` bridges SF Accounts to `public.companies`. No equivalent exists for contacts. When Pebble researches a prospect or the CRM shows a SF Contact, there's no way to know if that person already exists in `public.contacts` (16K rows from LinkedIn import).

### DDL

```sql
-- ── SF Contact ↔ public.contacts bridge ──
-- Same pattern as sf_account_company_map. Bedrock cannot write to
-- public.contacts (read-only on public.*), so the bridge lives here.
-- Matching logic: linkedin_url, email, or name+company.
-- NOTE: public.contacts is platform-managed (DDL not in this repo).
-- Verify available match columns (linkedin_url, email) with platform team before implementing.
CREATE TABLE IF NOT EXISTS bedrock.sf_contact_map (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_contact_id       TEXT NOT NULL,
    public_contact_id   INTEGER NULL,
    confidence          TEXT NOT NULL CHECK (confidence IN (
        'linkedin_url',         -- SF Contact.LinkedIn_URL__c matches contacts.linkedin_url
        'email',                -- SF Contact.Email matches contacts.email
        'name_company',         -- first+last+company match (weaker)
        'manual'                -- human admin confirmed
    )),
    matched_by          TEXT,           -- 'auto:matcher' or admin email
    matched_at          TIMESTAMPTZ DEFAULT now(),
    notes               TEXT
);

-- Unique: one mapping per SF Contact
CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_contact_map_sf_id
    ON bedrock.sf_contact_map(sf_contact_id);

-- Lookup by public contact
CREATE INDEX IF NOT EXISTS idx_sf_contact_map_contact_id
    ON bedrock.sf_contact_map(public_contact_id) WHERE public_contact_id IS NOT NULL;

-- Filter by confidence
CREATE INDEX IF NOT EXISTS idx_sf_contact_map_confidence
    ON bedrock.sf_contact_map(confidence);

-- Conditional FK to public.contacts (same pattern as sf_account_company_map)
DO $$ BEGIN
    ALTER TABLE bedrock.sf_contact_map
        ADD CONSTRAINT sf_contact_map_contact_fkey
        FOREIGN KEY (public_contact_id) REFERENCES public.contacts(contact_id) ON DELETE SET NULL;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped FK to public.contacts (restricted role)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped FK to public.contacts (table does not exist)';
END $$;
```

### Matching Strategy

Priority order (same as company matcher):
1. **LinkedIn URL** (strongest) — SF `Contact.LinkedIn_URL__c` vs `public.contacts.linkedin_url`. Both already store full LinkedIn URLs.
2. **Email** — SF `Contact.Email` vs `public.contacts.email`.
3. **Name + company** (weakest) — `lower(first_name || ' ' || last_name)` + company name from SF Contact's Account. Only used as a suggestion, requires manual confirmation. NOTE: The company match uses the SF Contact's Account name (via AccountId), not a column on `public.contacts` — the platform contacts table may lack a company field.

### Matcher Service

Create `services/sf_contact_matcher.py` following `services/sf_company_matcher.py`:
- `match_all()` — iterate SF Contacts, look up in `public.contacts`, insert into `sf_contact_map`
- `match_one(sf_contact_id)` — match a single contact
- Admin endpoints: `GET /api/admin/sf-contact-match` (list), `POST .../confirm` (manual match)

### When to Run

- On-demand via admin UI (like company matcher)
- After LinkedIn import into `public.contacts`
- After Pebble research identifies a new SF Contact

---

## 2. Staff Identity Consolidation

### Why

Every new app that uses Google OAuth would create its own `*_user` table with a FK back to `org_users`, duplicating email/name. Instead, `org_users` should be the canonical staff identity with org-wide fields. App-specific config goes in per-app tables.

### Current State

```
public.org_users (8 cols):  id, google_id, email, display_name, avatar_url, 
                            slack_user_id, created_at, updated_at

bedrock.app_user (9 cols):  id, sf_user_id, email, name, profile_id, is_active,
                            org_user_id (FK → org_users), created_at, updated_at
```

`app_user` duplicates `email` and `name` from `org_users`, then adds `sf_user_id`, `profile_id`, `is_active`.

### Target State

```sql
-- Step 1: Add org-wide fields to public.org_users
ALTER TABLE public.org_users
    ADD COLUMN IF NOT EXISTS sf_user_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Step 2: Create bedrock-specific config (replaces app_user)
CREATE TABLE IF NOT EXISTS bedrock.user_config (
    org_user_id     UUID PRIMARY KEY,
    profile_id      UUID REFERENCES bedrock.permission_profile(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Conditional FK to public.org_users (same pattern as app_user.org_user_id, init.sql:268-279)
DO $$ BEGIN
    ALTER TABLE bedrock.user_config
        ADD CONSTRAINT user_config_org_user_fkey
        FOREIGN KEY (org_user_id) REFERENCES public.org_users(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipped FK to public.org_users (restricted role)';
    WHEN undefined_table THEN
        RAISE NOTICE 'Skipped FK to public.org_users (table does not exist)';
END $$;

CREATE OR REPLACE TRIGGER trg_user_config_updated_at
    BEFORE UPDATE ON bedrock.user_config
    FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
```

### Migration Steps

```sql
-- Step 3: Backfill sf_user_id onto org_users from app_user
UPDATE public.org_users ou
SET sf_user_id = au.sf_user_id
FROM bedrock.app_user au
WHERE au.org_user_id = ou.id
  AND au.sf_user_id IS NOT NULL
  AND ou.sf_user_id IS NULL;
-- NOTE: This UPDATE writes to public.org_users — same permission
-- restriction as Step 1. Must be run by superuser or Jac, not bedrock_user.

-- Step 4: Populate user_config from app_user
INSERT INTO bedrock.user_config (org_user_id, profile_id)
SELECT au.org_user_id, au.profile_id
FROM bedrock.app_user au
WHERE au.org_user_id IS NOT NULL
ON CONFLICT (org_user_id) DO NOTHING;

-- Step 5: Update all bedrock code to query org_users + user_config
-- (code changes listed below)

-- Step 6: After code migration verified, drop app_user
-- DROP TABLE bedrock.app_user;  -- only after all references removed
```

### Code Changes Required

| File | Current | Target |
|------|---------|--------|
| `routes/auth.py` | Creates/updates `app_user` on login | Creates/updates `org_users` + `user_config` |
| `routes/permissions.py` | Queries `app_user` for profile | Queries `org_users JOIN user_config` |
| `routes/permissions.py` | `get_user_permissions()` lazy-links `org_user_id` | No longer needed — `org_users` IS the identity |
| `routes/projects.py` | `app_user.email` for ownership | `org_users.email` |
| `routes/activities.py` | `app_user.sf_user_id` for SF queries | `org_users.sf_user_id` |
| `dependencies.py` | Permission check via `app_user` | Permission check via `org_users JOIN user_config` |
| `db/init.sql` | `app_user` table definition | `user_config` table + `org_users` ALTER |
| Frontend `PermissionsContext.tsx` | Reads `app_user` fields from API | Same API shape, backed by different tables |

### Permission Note

`bedrock_user` currently has read-only on `public.*`. Steps 1 AND 3 both write to `public.org_users`:
- **Step 1 (ALTER):** Run as `postgres` superuser or a role with ALTER rights
- **Step 3 (UPDATE):** Run as `postgres` superuser or a role with UPDATE rights on `public.org_users`
- Jac runs both manually. Steps 2 and 4 are bedrock-schema-only and can be run by `bedrock_user` or init.sql.
- After Step 1, `bedrock_user` can SELECT the new columns like any other public column

### Prerequisites

1. **Phase B-3 backfill must run first** — `db/migrations/2026-04-08-backfill-app-user-org-link.sql` populates `app_user.org_user_id` by email match to `public.org_users`. Steps 3-4 read this column to copy data. Without the backfill, most rows will have `org_user_id = NULL` and be silently skipped.
2. **Identity audit after backfill** — Run `GET /api/permissions/admin/identity-audit` (`routes/permissions.py:351`) to check for unlinked users. Any `app_user` rows with `org_user_id = NULL` after the backfill need manual resolution (platform onboarding or manual link) before proceeding.

### Rollout Order

1. Add `sf_user_id` and `is_active` to `public.org_users` (Jac runs ALTER, no app impact)
2. Create `bedrock.user_config` table (additive, no impact)
3. Backfill `sf_user_id` on `org_users` from `app_user` (data migration)
4. Backfill `user_config` from `app_user` (data migration)
4b. Run identity audit (`GET /api/permissions/admin/identity-audit`) to verify: all users linked, `sf_user_id` values populated on `org_users`, `user_config` rows match `app_user` count.
5. Update bedrock code to read from `org_users` + `user_config` (code PR)
6. Run in parallel: both `app_user` and new tables populated on login (transition period)
7. Verify parity, then drop `app_user`

Steps 1-4 are non-breaking and can ship immediately. Step 5 is the main code PR. Steps 6-7 are cleanup.

---

## What This Enables

After both changes, the cross-schema identity layer is complete:

| Entity | Bridge | Status |
|--------|--------|--------|
| Staff (users) | `org_users` + `user_config` | This spec |
| Companies | `sf_account_company_map` | Done (JP) |
| Contacts | `sf_contact_map` | This spec |

Any future app (e.g., alumni portal, volunteer management) references `org_users` for staff identity and can add its own `{schema}.user_config` for app-specific settings. No more parallel user tables.
