-- 2026-06-07: Candidate funnel — unified surface for companies and people we've
-- touched in Gmail/Calendar but haven't tracked yet in Salesforce or
-- public.companies / public.contacts.
--
-- See tasks/candidate-funnel-plan.md for the full design.
--
-- account_candidate: one row per unique external company (keyed by primary_domain).
-- contact_candidate: one row per unique external person (keyed by email).
-- bedrock.activity: 4 new attribution columns wire each activity participant
-- to whichever resolution layer it landed on (SF Contact / public.contacts /
-- contact_candidate / account_candidate).
--
-- segundo-db doesn't grant CREATE EXTENSION citext, so emails/domains are TEXT
-- with LOWER() expression indexes. Callers normalize before insert.

CREATE TABLE IF NOT EXISTS bedrock.account_candidate (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identity (one row per unique company)
    primary_domain    text NOT NULL UNIQUE,        -- normalized: lowercase, www. stripped
    display_name      text,                         -- inferred from email signatures / org name
    alt_domains       text[] NOT NULL DEFAULT '{}', -- subdomains, ccTLDs, prior names

    -- Provenance
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now(),
    first_source      text NOT NULL,                -- 'gmail-sync' | 'calendar-sync' | 'manual' | 'scan_seed'
    signal_count      int NOT NULL DEFAULT 0,       -- activity rows touching this candidate
    unique_people     int NOT NULL DEFAULT 0,       -- distinct people we've corresponded with at this domain

    -- Linkage to canonical registries. public.companies FK is soft (no REFERENCES
    -- privilege granted to Bedrock); validated in application code on insert.
    public_company_id integer,
    sf_account_id     text,                         -- 18-char SF id, set on promote
    merged_into_id    uuid REFERENCES bedrock.account_candidate(id),

    -- Lifecycle
    status            text NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'tracking', 'in_registry', 'promoted', 'merged', 'rejected')),
    reviewed_by       text,
    reviewed_at       timestamptz,
    notes             text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_candidate_status
    ON bedrock.account_candidate(status);
CREATE INDEX IF NOT EXISTS idx_account_candidate_domain_lower
    ON bedrock.account_candidate(LOWER(primary_domain));
CREATE INDEX IF NOT EXISTS idx_account_candidate_signal
    ON bedrock.account_candidate(signal_count DESC) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_account_candidate_sf_account
    ON bedrock.account_candidate(sf_account_id) WHERE sf_account_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS bedrock.contact_candidate (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    email                 text NOT NULL UNIQUE,    -- normalized lowercase
    display_name          text,
    first_seen_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at          timestamptz NOT NULL DEFAULT now(),
    first_source          text NOT NULL,
    signal_count          int  NOT NULL DEFAULT 0,

    -- Linkage to canonical registries / SF (public.contacts FK is soft — see above)
    account_candidate_id  uuid REFERENCES bedrock.account_candidate(id),
    sf_account_id         text,                    -- denormalized convenience
    sf_contact_id         text,                    -- set on promote
    public_contact_id     integer,

    status                text NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'tracking', 'in_registry', 'promoted', 'merged', 'rejected')),
    reviewed_by           text,
    reviewed_at           timestamptz,

    title                 text,
    linkedin_url          text,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_candidate_email_lower
    ON bedrock.contact_candidate(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_contact_candidate_account
    ON bedrock.contact_candidate(account_candidate_id);
CREATE INDEX IF NOT EXISTS idx_contact_candidate_sf_account
    ON bedrock.contact_candidate(sf_account_id) WHERE sf_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_candidate_status
    ON bedrock.contact_candidate(status);
CREATE INDEX IF NOT EXISTS idx_contact_candidate_signal
    ON bedrock.contact_candidate(signal_count DESC) WHERE status = 'new';


-- Activity attribution columns. Today only account_id and contact_ids are populated;
-- these four make the resolution chain explicit per participant.
ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS account_candidate_id          uuid REFERENCES bedrock.account_candidate(id),
    ADD COLUMN IF NOT EXISTS participant_candidate_id      uuid REFERENCES bedrock.contact_candidate(id),
    ADD COLUMN IF NOT EXISTS participant_public_contact_id integer,  -- soft ref to public.contacts(contact_id)
    ADD COLUMN IF NOT EXISTS participant_sf_contact_id     text;

CREATE INDEX IF NOT EXISTS idx_activity_account_candidate
    ON bedrock.activity(account_candidate_id) WHERE account_candidate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_participant_candidate
    ON bedrock.activity(participant_candidate_id) WHERE participant_candidate_id IS NOT NULL;
