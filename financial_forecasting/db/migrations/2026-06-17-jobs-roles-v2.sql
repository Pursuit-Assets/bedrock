-- Phase 1 role-model upgrade
-- ============================
-- Locked counting rule (jobs team, 2026-06-17):
--   * Secured / placed FT = ACTIVE full-time placements only. A trial/work-trial
--     placement does NOT count, even with conversion intent.
--   * Committed counts the FT role (incl. future-dated, pre-conversion) so the
--     full picture is visible. When the trial converts and the FT goes active,
--     it moves from committed -> placed.
--   * Open-market roles (contact will take CVs but hasn't committed to hiring)
--     must NOT count toward committed.
--
-- jobs_role is owned by `postgres`; apply this as a superuser. bedrock_user's
-- existing table grants extend to new columns automatically.

BEGIN;

-- Commitment level — open-market roles are tracked but excluded from committed.
ALTER TABLE bedrock.jobs_role
  ADD COLUMN IF NOT EXISTS commitment text NOT NULL DEFAULT 'committed'
    CHECK (commitment IN ('committed', 'open_market'));

-- Trial / paid-work-trial. Trials are recorded as contract employment and do not
-- count as secured FT; they typically convert into a linked FT role.
ALTER TABLE bedrock.jobs_role
  ADD COLUMN IF NOT EXISTS is_trial boolean NOT NULL DEFAULT false;

-- Dual-role conversion: the trial role points to the FT role it converts into.
ALTER TABLE bedrock.jobs_role
  ADD COLUMN IF NOT EXISTS converts_to_role_id uuid
    REFERENCES bedrock.jobs_role(id) ON DELETE SET NULL;

-- Richer compensation — an annual salary int can't represent contracts/trials
-- (e.g. "$85k annualized but paid hourly for 8 weeks").
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS pay_rate          numeric;  -- rate amount
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS rate_period       text
    CHECK (rate_period IS NULL OR rate_period IN ('annual','monthly','weekly','daily','hourly'));
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS end_date          date;
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS pay_cadence       text;     -- e.g. biweekly, monthly
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS benefits          text;
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS payment_schedule  text;
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS negotiation_notes text;
ALTER TABLE bedrock.jobs_role ADD COLUMN IF NOT EXISTS jd_url            text;     -- JD link (esp. open-market)

CREATE INDEX IF NOT EXISTS idx_jobs_role_converts_to ON bedrock.jobs_role(converts_to_role_id);

COMMIT;
