-- Add full email body and attachment storage to bedrock.activity
-- Attachments stored in GCS bucket: bedrock-email-content

ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS email_body_text  TEXT,
    ADD COLUMN IF NOT EXISTS email_messages   JSONB,
    ADD COLUMN IF NOT EXISTS attachments      JSONB;

-- Update search vector trigger to include body text (weight C, same as description)
-- The trigger function is already defined; we need to update it to include email_body_text.
CREATE OR REPLACE FUNCTION bedrock.activity_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.subject, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.email_snippet, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.email_body_text, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
