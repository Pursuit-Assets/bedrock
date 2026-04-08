# Contact & Company Source Governance

> **Status:** Foundation shipped 2026-04-08. Bedrock side complete. Platform team ask outstanding (see §5).
>
> **Owner:** JP (Bedrock side) + platform team (public.* side)
>
> **Code:** `financial_forecasting/source_governance.py`, `financial_forecasting/services/sf_company_matcher.py`, `financial_forecasting/db/init.sql` (CHECK constraints)

## Why this exists

Pursuit has two distinct populations of contacts and organizations on segundo-db:

1. **Builder-facing data** — LinkedIn scrapes, Sputnik/Pathfinder career data, Clearbit company enrichment. Builders use this for job applications, networking, and connection introductions. Lives in `public.contacts` and `public.companies` (with FKs from `public.staff_contact_relationships`, `public.intro_requests`, `public.outreach`, `public.job_applications`).

2. **Staff-only data** — Salesforce donor pipeline contacts, Pebble research output (HNWI lookups), CSV uploads of VIP prospect lists from leadership. This is sensitive — Builders should never see donor information, prospect research notes, or wealth-indicator data.

The two populations can — and do — overlap. The same person may be a Builder's LinkedIn connection AND a researched donor prospect. The same company may be both a workshop partner AND an SF Account funder. The data lives in different tables today (Bedrock keeps prospect data in `bedrock.prospect_sf_*` and Salesforce; the platform keeps career data in `public.contacts` / `public.companies`), but as cross-system features land (Pebble enriching LinkedIn contacts, the SF↔companies bridge for "show Builders at this funder"), the two populations will start sharing rows.

**The risk:** Without governance, a Bedrock-sourced HNWI prospect could end up in `public.contacts` (via a future SF→public sync) and become visible to Builders through `intro_requests`, contact search, or networking suggestions. That would leak donor data into student-facing UI.

**The foundation:** Every contact and company row carries a `source` value identifying where it originated. Builder-facing queries filter by source to exclude staff-only origins.

## Verified facts about the existing schema (2026-04-08)

- `public.contacts.source varchar(100)` exists. **All 16,646 rows are tagged `linkedin_import`.** No NULLs.
- `public.companies.source varchar(50) DEFAULT 'manual'` exists. 11,427 rows: `linkedin_import` (9,743), `clearbit` (1,378), `manual` (306). No NULLs.
- `public.companies.enrichment_source varchar(50) DEFAULT 'claude_ai'` also exists — the platform already distinguishes "where this record originally came from" from "what enriched it later."
- `public.contacts` does NOT have `enrichment_source`. The platform team should add it (see §5).
- The platform team's existing source values are aligned with this governance doc — we are NOT renaming or backfilling existing rows.

## 1. The canonical enum

| Source | Visibility | Created by | Notes |
|---|---|---|---|
| `linkedin_import` | **Builder-visible** | Sputnik/Pathfinder LinkedIn scrape | Existing platform value, 16,646+9,743 rows |
| `clearbit` | **Builder-visible** | Sputnik company enrichment via Clearbit API | Existing platform value, 1,378 company rows |
| `manual` | **Builder-visible** | Platform UI hand-entry | Existing platform value, 306 company rows. Defaults to Builder-visible since the platform's whole purpose is Builder career support. If a future workflow needs staff-only manual entry on the platform, use `manual_staff` instead. |
| `sputnik` | **Builder-visible** | Sputnik direct creates not via LinkedIn | NEW. Reserved for Sputnik flows that don't go through `linkedin_import` (e.g., workshop partner adds, employer self-serve). |
| `platform_user_added` | **Builder-visible** | Builder hand-added a connection | NEW. For when a Builder manually adds someone they already know to the system. |
| `salesforce` | **STAFF ONLY** | Bedrock SF sync | NEW. Any contact or account that originated in Salesforce (donor pipeline). Set when Bedrock syncs SF Contacts/Accounts into shared tables, OR when SF Contact `LeadSource` triggers a future SF→public sync. |
| `pebble_research` | **STAFF ONLY** | Pebble research pipeline | NEW. Default for `bedrock.prospect_sf_contact` and `bedrock.prospect_sf_account` rows created by `pebble/handlers/tier{1,2,3}.py`. |
| `bedrock_prospect_import` | **STAFF ONLY** | CSV upload via prospect_import | NEW. Default for the future `bedrock.prospect_import_*` tables (Claim 5A). HNWI lists from leadership land here. |
| `manual_staff` | **STAFF ONLY** | Bedrock UI staff hand-entry | NEW. For when a staff member manually adds a contact in Bedrock that needs to be staff-only. |

**Visibility rule:** A record is Builder-visible iff its source is in `BUILDER_VISIBLE_SOURCES`. NULL or unknown sources default to staff-only (conservative deny). See `source_governance.is_builder_visible()` for the canonical check.

**Enrichment is NOT origin.** When Pebble enriches a `linkedin_import` contact with research data, the contact's `source` STAYS `linkedin_import` (it still originated from LinkedIn), but its `enrichment_source` becomes `pebble_research`. Visibility is decided by `source`, not `enrichment_source`. This is the platform's existing pattern on `public.companies` (`source` + `enrichment_source` columns) and we adopt the same separation.

## 2. Where each source is set

| Source | Set by | Code path |
|---|---|---|
| `linkedin_import` | Platform's LinkedIn scraper | Platform team owns; not Bedrock code |
| `clearbit` | Platform's Sputnik company-enrichment job | Platform team owns |
| `manual` | Platform UI manual-add forms | Platform team owns |
| `sputnik` | Future Sputnik direct flows | Platform team owns |
| `platform_user_added` | Future Builder-facing add forms | Platform team owns |
| `salesforce` | Bedrock SF sync (future) | Will live in a sync layer that doesn't exist yet. When built, it sets `source='salesforce'` on every row pushed from SF to `public.contacts`/`public.companies`. |
| `pebble_research` | Pebble tier handlers | `pebble/handlers/tier{1,2,3}.py` calls `save_prospect_sf_contact/account` → row gets `source='pebble_research'` from the column DEFAULT. |
| `bedrock_prospect_import` | prospect_import (Claim 5A) | Future `routes/prospects.py` write paths will set this explicitly when CSV-uploaded prospects land in `bedrock.prospect_import_person/org`. |
| `manual_staff` | Bedrock UI manual-add forms (future) | Reserved for when Bedrock grows a "create contact" form that's NOT going via Pebble research or SF. |

## 3. Bedrock-side enforcement

### Schema (db/init.sql)

`bedrock.prospect_sf_contact` and `bedrock.prospect_sf_account` both have:

```sql
source TEXT NOT NULL DEFAULT 'pebble_research'
enrichment_source TEXT
CHECK (source IN (
    'linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added',
    'salesforce', 'pebble_research', 'bedrock_prospect_import', 'manual_staff'
))
```

The CHECK constraint enforces the canonical enum at the storage layer. Any attempt to insert a row with an unknown source value fails with a constraint violation, before the row hits disk.

### Python helper (`source_governance.py`)

```python
from source_governance import is_builder_visible, validate_source, ContactSource

# Validate at write boundaries
contact["source"] = validate_source(user_input)  # raises ValueError on typo

# Filter at read boundaries
visible = [c for c in contacts if is_builder_visible(c["source"])]
```

Single source of truth for the enum, the visibility rule, and the validation. Mirrors the CHECK constraints in `init.sql`.

## 4. Cross-system queries that need filtering

When Bedrock queries `public.contacts` or `public.companies` directly (for cross-domain features like "show Builders at this funder"), it MUST filter by `is_builder_visible(source)` if the result will be shown to a Builder, OR explicitly bypass the filter for staff-only views.

Example pattern for a future Bedrock endpoint that lists Builders at a funder:

```sql
SELECT u.first_name, u.last_name, ja.status
FROM public.job_applications ja
JOIN public.users u ON u.user_id = ja.user_id
JOIN public.companies c ON c.company_id = ja.company_id
JOIN bedrock.sf_account_company_map m ON m.public_company_id = c.company_id
WHERE m.sf_account_id = $1
  AND c.source IN ('linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added')
```

The `WHERE c.source IN (...)` clause is the visibility filter. The Python helper `is_builder_visible()` is the canonical source for what goes in that list, so the Python and SQL stay in sync as new values are added.

## 5. Platform team ask

**This section is self-contained and can be lifted directly into a ticket for the platform team.**

The Bedrock fundraising CRM is introducing structured provenance tracking for contacts and companies so that staff-only data (donor records, prospect research output) cannot accidentally leak into Builder-facing surfaces (intro requests, networking suggestions, contact search, outreach UI). The `source` columns you already maintain on `public.contacts` and `public.companies` are exactly the right hook — we just need to align on the canonical enum and add a few light enforcements.

**Context queries we ran (read-only) on segundo-db on 2026-04-08:**

- `public.contacts.source` is uniformly `linkedin_import` across all 16,646 rows.
- `public.companies.source` distribution: `linkedin_import` (9,743), `clearbit` (1,378), `manual` (306). Total 11,427 rows.
- `public.companies.enrichment_source` already exists with default `'claude_ai'`. `public.contacts.enrichment_source` does NOT exist.

### Asks (in priority order)

1. **Add a CHECK constraint on `public.contacts.source` and `public.companies.source`** with the canonical enum below. Zero existing rows would be rejected (verified — they all use `linkedin_import` / `clearbit` / `manual` already).

   ```sql
   ALTER TABLE public.contacts
       ADD CONSTRAINT contacts_source_chk CHECK (source IN (
           'linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added',
           'salesforce', 'pebble_research', 'bedrock_prospect_import', 'manual_staff'
       ));

   ALTER TABLE public.companies
       ADD CONSTRAINT companies_source_chk CHECK (source IN (
           'linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added',
           'salesforce', 'pebble_research', 'bedrock_prospect_import', 'manual_staff'
       ));
   ```

2. **Add `enrichment_source TEXT` column on `public.contacts`** to mirror what `public.companies` already has. No default needed; let it be NULL until something writes to it. This unlocks the future "Pebble enriches a LinkedIn contact" workflow without changing the row's `source`.

3. **Update Builder-facing queries to filter by `source`.** Specifically, every query that powers a Builder-visible UI surface must add `WHERE source IN ('linkedin_import', 'clearbit', 'manual', 'sputnik', 'platform_user_added')`. The four staff-only values (`salesforce`, `pebble_research`, `bedrock_prospect_import`, `manual_staff`) must NOT appear in any Builder-visible result set. Surfaces to audit:

   - **Intro requests UI** — `public.intro_requests.contact_id` query path
   - **Contact search** in Sputnik / Pathfinder
   - **Networking suggestions** that surface contacts to Builders
   - **Outreach tracking** — `public.outreach.contact_id` query path
   - **`public.staff_contact_relationships`** — relationships are already gated by `is_visible_to_builders BOOLEAN`, so this is double-protected. But the FK `staff_contact_relationships.contact_id → contacts(contact_id)` means a Builder querying their own staff connections could see contacts; ensure those queries also filter by source.
   - **`public.job_applications`** — companies surfaced through job application flows must filter by `companies.source`.

4. **Decide on insertion-side enforcement.** Right now there's no constraint on which `source` value can be set when. If a future Bedrock-side process (or a sync job) writes `salesforce` into `public.contacts.source`, the visibility filter (ask #3) catches the leak. But if you want belt-and-suspenders, a row-level security policy or a write-side check would prevent the row from being created at all in Builder-facing tables. This is your call.

### What's already done on the Bedrock side

- The canonical enum is implemented in `financial_forecasting/source_governance.py` and enforced via CHECK constraints on `bedrock.prospect_sf_contact.source` and `bedrock.prospect_sf_account.source`.
- The matcher service (`financial_forecasting/services/sf_company_matcher.py`) writes SF Account ↔ `public.companies` mappings into `bedrock.sf_account_company_map`. This unblocks the "show Builders at this funder" cross-domain query without requiring write access to `public.companies`.
- An admin-only review queue is exposed at `/api/admin/sf-company-match` for verifying low-confidence matches.

### Reference

- Code: `financial_forecasting/source_governance.py`
- Schema: `financial_forecasting/db/init.sql` (search for `prospect_sf_contact_source_chk`)
- Architecture context: `docs/database-schema-atlas.md` §11 (Namespace Collision Analysis)
- Bedrock role permissions: `docs/database-schema-rundown.md` §1

## 6. Future enrichment story

When Pebble research enriches a LinkedIn-sourced contact with new data (job title, philanthropic interests, wealth indicators), the contact's `source` stays `linkedin_import` (its origin doesn't change). The enrichment data lives in one of two places:

- **`enrichment_source = 'pebble_research'`** on the platform's contact row (after the platform team ships ask #2 above)
- **A separate `bedrock.contact_enrichment` overlay table** linked by `contact_id`, holding only the enriched fields. Bedrock can query this for staff-facing views (Pebble research dashboard, donor research briefs); the platform's Builder-facing queries don't see it because they don't join to `bedrock.*`.

The contact remains Builder-visible (because `source = 'linkedin_import'`), so Builders can still find this person via networking search. Staff additionally see the Pebble overlay, which is staff-only by virtue of living in `bedrock.*`. **This is the minimum-disruption pattern** — no migration of existing rows, no change to visibility for the base record, additive overlay for the enrichment.

A more aggressive approach would be to "downgrade" any Pebble-enriched contact to staff-only. This would protect against the case where Pebble research uncovers something sensitive (e.g., "this Builder's mom is a major donor we shouldn't approach directly"). The trade-off is that downgrading hides the contact from the Builder networking flow, which is likely the wrong default. **Recommend keeping `source` immutable and using a separate `is_sensitive` flag if/when we need the staff-only-after-enrichment behavior.** Decision deferred to a later sprint.

## 7. The Claim 4 connection

The senior dev review flagged that `data_sync.py` doesn't link SF Accounts (Bedrock's funder records) to `public.companies` (the platform's employer records). Their proposed fix was to write `salesforce_account_id` directly onto `public.companies`, but Bedrock has read-only permission on `public.*` and cannot do that.

The atlas (`docs/database-schema-atlas.md:1201`) pre-named the right fix: a `bedrock.org_identity_map` mapping table. This doc ships that table as `bedrock.sf_account_company_map` with the matcher service in `services/sf_company_matcher.py` and the admin review endpoints in `routes/admin_company_match.py`. The senior dev's underlying concern is addressed; the table just lives on the Bedrock side because that's the only place Bedrock can write.
