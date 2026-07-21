-- Contact owner + curated tag vocabulary (2026-07-21)
-- 1. owner_email on public.contacts — org-wide single owner, staff picker in UI.
-- 2. bedrock.contact_tag_catalog — the curated tag vocabulary (UI picker reads
--    this; contacts.tags stores the slugs). System markers (email_review) stay
--    in contacts.tags but are never in the catalog, so the UI never shows them.
-- Idempotent.

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS owner_email text;
CREATE INDEX IF NOT EXISTS idx_contacts_owner_email ON public.contacts (owner_email) WHERE owner_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tags ON public.contacts USING gin (tags) WHERE tags IS NOT NULL;

CREATE TABLE IF NOT EXISTS bedrock.contact_tag_catalog (
  slug        text PRIMARY KEY,
  label       text NOT NULL,
  sort_order  int  NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bedrock.contact_tag_catalog (slug, label, sort_order) VALUES
  ('prior_commit_partner', 'Prior Commit Partner', 10),
  ('other_hiring_partner', 'Hiring Partner',       20),
  ('commit_company',       'Commit Company',       30),
  ('board',                'Board',                40),
  ('opboard',              'Op Board',             50),
  ('ciso_council',         'CISO Council',         60),
  ('volunteer_current',    'Volunteer (Current)',  70),
  ('volunteer_historical', 'Volunteer (Past)',     80),
  ('bash_attendee',        'BASH Attendee',        90),
  ('staff_network',        'Staff Network',        100),
  ('alumni_1',             'Alumni — Cohort 1',    110),
  ('alumni_2',             'Alumni — Cohort 2',    111),
  ('alumni_3',             'Alumni — Cohort 3',    112),
  ('alumni_4',             'Alumni — Cohort 4',    113),
  ('alumni_5',             'Alumni — Cohort 5',    114),
  ('alumni_6',             'Alumni — Cohort 6',    115),
  ('alumni_7',             'Alumni — Cohort 7',    116),
  ('alumni_8',             'Alumni — Cohort 8',    117),
  ('alumni_9',             'Alumni — Cohort 9',    118),
  ('alumni_10',            'Alumni — Cohort 10',   119),
  ('alumni_11',            'Alumni — Cohort 11',   120),
  ('alumni_ai_native',     'Alumni — AI Native',   121)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- The app's runtime roles need to read the catalog
GRANT SELECT ON bedrock.contact_tag_catalog TO bedrock_user;
GRANT SELECT ON bedrock.contact_tag_catalog TO jobs_dev;
GRANT SELECT ON bedrock.contact_tag_catalog TO readonly_user;
GRANT SELECT ON bedrock.contact_tag_catalog TO ceo_dev;
