-- Persistent Jobs account record.
--
-- The jobs pipeline is account-centric, but accounts were only ever implied by
-- the company-name text on opportunities/contacts. This gives the account a real
-- home so we can edit account-level fields (owner) and, later, pin a manual
-- status override or notes. Keyed by the normalized company name — the only key
-- shared by opportunities (account_name) and contacts (current_company); SF
-- account_id is too sparse to group on.
--
-- Owned by bedrock_user (the app role), so the app can read/write it directly.

CREATE TABLE IF NOT EXISTS bedrock.jobs_account (
    account_key     text PRIMARY KEY,          -- lower(trim(company name))
    display_name    text,                      -- best-known display casing
    owner_email     text,                      -- account owner (editable)
    status_override text,                      -- optional manual status; else derived
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.jobs_account TO bedrock_user;
