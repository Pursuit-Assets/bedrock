-- Revert bulk-created 'assigned' memberships (2026-07-23, Jac's correction):
-- 'assigned' must mean an actual pipeline assignment, not a blanket entry.
-- The tagged network stays in the campaign population (is_jobs_contact / tags);
-- contacts with no real stage should read as blank / not-yet-assigned (gray),
-- not amber-assigned. Deletes the memberships created today by the
-- tagged-into-pipeline (activation_reason='algorithm') and tristate
-- (activation_reason='strategic') bulk adds. Real work stages
-- (initial_outreach/converted_to_opportunity/on_hold) and manual assignments
-- are untouched. Idempotent.
DELETE FROM bedrock.jobs_contact_membership
WHERE stage = 'assigned' AND activation_reason IN ('algorithm', 'strategic');
