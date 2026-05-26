-- 2026-05-25: Domain → SF Account lookup for activity account resolution.
--
-- Populated from SF Account.Website (1590 accounts) and from the email domains
-- of contacts already linked to accounts via sf_contact_link.
-- Used by gmail_sync / calendar_sync to link activities to accounts even when
-- the external participant is not in public.contacts.

CREATE TABLE IF NOT EXISTS bedrock.account_email_domain (
    domain          TEXT PRIMARY KEY,
    sf_account_id   TEXT NOT NULL,
    sf_account_name TEXT,
    source          TEXT NOT NULL DEFAULT 'sf_website'
        CHECK (source IN ('sf_website', 'contact_link', 'manual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_email_domain_account
    ON bedrock.account_email_domain(sf_account_id);
