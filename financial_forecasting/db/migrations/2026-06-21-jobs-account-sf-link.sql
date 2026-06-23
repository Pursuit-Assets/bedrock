-- Persist an explicit Salesforce link on a jobs account (promote-to-SF).
-- An account already reads as "in SF" when its opps carry a real SF
-- account_id; this column lets a promote pin the link even when no opp does.
-- bedrock_user owns jobs_account.

ALTER TABLE bedrock.jobs_account
    ADD COLUMN IF NOT EXISTS sf_account_id text;
