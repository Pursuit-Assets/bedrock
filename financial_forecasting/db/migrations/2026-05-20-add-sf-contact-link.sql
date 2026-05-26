-- 2026-05-20: SF Contact → public.contacts identity link table.
--
-- Mirrors bedrock.sf_account_company_map (company side) for contacts.
-- Populated by services/sf_contact_matcher.py which walks SF Contacts
-- and resolves each to a row in public.contacts by email, then
-- linkedin_url, then name+company (fuzzy — requires human review).
--
-- Bedrock cannot write to public.contacts (read-only on public.*), so
-- the bridge lives here on the bedrock side.

CREATE TABLE IF NOT EXISTS bedrock.sf_contact_link (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sf_contact_id     TEXT NOT NULL,
    public_contact_id INTEGER NULL,  -- public.contacts.contact_id
    confidence        TEXT NOT NULL CHECK (confidence IN (
        'email',          -- direct email match (high confidence)
        'linkedin_url',   -- LinkedIn URL match (medium confidence)
        'name_company',   -- name + company fuzzy (low — needs review)
        'manual'          -- human admin confirmed via review UI
    )),
    matched_by        TEXT,
    matched_at        TIMESTAMPTZ DEFAULT now(),
    notes             TEXT,
    UNIQUE(sf_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_contact_link_sf_id
    ON bedrock.sf_contact_link(sf_contact_id);

CREATE INDEX IF NOT EXISTS idx_sf_contact_link_contact_id
    ON bedrock.sf_contact_link(public_contact_id)
    WHERE public_contact_id IS NOT NULL;
