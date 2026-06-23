-- Jobs opportunities: track the Relationship Owner separately from the Owner.
-- `owner_email` = Pursuit Lead (who runs the deal); `relationship_owner` =
-- who owns the employer relationship. Both reference Pursuit staff emails.
-- bedrock_user owns jobs_opportunity, so no elevated grant needed.

ALTER TABLE bedrock.jobs_opportunity
    ADD COLUMN IF NOT EXISTS relationship_owner text;
