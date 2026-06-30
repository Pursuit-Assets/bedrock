-- Persisted AI enrichment for email-review candidates, so the review queue/drawer
-- show findings instantly (batch pre-computed) instead of a live call per open.
CREATE TABLE IF NOT EXISTS bedrock.candidate_enrichment (
    contact_id             integer PRIMARY KEY,
    full_name              text,
    title                  text,
    company                text,
    linkedin_url           text,
    is_employer_contact    boolean,
    confidence             text,
    reasoning              text,
    account_suggestion     jsonb,
    possible_duplicate_ids integer[] DEFAULT '{}',
    model                  text,
    enriched_at            timestamptz DEFAULT now()
);
