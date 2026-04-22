-- 2026-04-22: register the Bedrock CRM surface in pd_surface_registry
--
-- Context:
--     pd_tickets.surface_id is a UUID FK into pd_surface_registry.
--     The existing 12 rows cover Learning / Admissions / xProduct
--     product areas — none of them represent the Bedrock CRM (Revenue
--     Hub, Salesforce-backed sales pipeline). Without a surface row,
--     every Bedrock-originated ticket would have to set surface_id = NULL,
--     which defeats the whole point of having the column.
--
--     We intentionally register ONE surface for Bedrock rather than 10
--     (one per component in the intake form). The fine-grained component
--     the reporter picked is preserved at the top of the ticket
--     `description` as a **Component:** ... header, which is where
--     downstream triage (Slack bridge, Linear sync) actually looks.
--
-- Related:
--     * routes/platform_intake.py — reads `BEDROCK_SURFACE_ID` (env-
--       overridable, defaults to the UUID this migration produces in prod)
--     * db/migrations/2026-04-22-pd-tickets-grants.sql (companion)
--
-- Idempotent on `name='Bedrock'` — safe to re-run.
--
-- Apply as postgres superuser:
--     psql "$SUPERUSER_URL" -f 2026-04-22-bedrock-surface-registry.sql

INSERT INTO public.pd_surface_registry (name, description, product_area)
SELECT
    'Bedrock',
    'Bedrock CRM / Revenue Hub — sales pipeline, opportunities, accounts, contacts, tasks, Salesforce sync',
    'Revenue Hub'
WHERE NOT EXISTS (
    SELECT 1 FROM public.pd_surface_registry WHERE name = 'Bedrock'
);

-- After insert, capture the UUID for the route's BEDROCK_SURFACE_ID env var:
--     SELECT id FROM public.pd_surface_registry WHERE name = 'Bedrock';
-- Prod UUID (2026-04-22): 95226ef9-a8cb-46ac-b1bb-8c5a45957092
