-- Revert an unwanted teammate bulk stage edit (2026-07-23 17:24-17:26, Jac).
-- The teammate flipped 58 memberships to on_hold/assigned. Restore each to its
-- true prior stage, reconstructed from the preserved stage-entry timestamps
-- (converted_at > first_outreach_at > assigned_at). Scoped strictly to rows
-- changed in that window; touches stage only. Idempotent.
UPDATE bedrock.jobs_contact_membership m
SET stage = CASE
      WHEN m.converted_at IS NOT NULL THEN 'converted_to_opportunity'
      WHEN m.first_outreach_at IS NOT NULL THEN 'initial_outreach'
      ELSE 'assigned' END,
    updated_at = now()
WHERE m.updated_at BETWEEN '2026-07-23 17:20:00+00' AND '2026-07-23 17:30:00+00'
  AND m.stage <> (CASE
      WHEN m.converted_at IS NOT NULL THEN 'converted_to_opportunity'
      WHEN m.first_outreach_at IS NOT NULL THEN 'initial_outreach'
      ELSE 'assigned' END);
