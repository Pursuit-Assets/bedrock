-- Pipeline model correction (2026-07-23, Jac): "in the pipeline" = the
-- jobs-prospect flag (public.contacts.is_jobs_contact), NOT a membership row.
-- Membership stage is only a REAL funnel position (initial_outreach /
-- converted_to_opportunity / on_hold). The bulk 'assigned' placeholder
-- memberships are wrong — delete them. Every affected contact is already
-- is_jobs_contact=true, so they remain in the pipeline via the checkbox.
-- Idempotent.
DELETE FROM bedrock.jobs_contact_membership WHERE stage = 'assigned';
