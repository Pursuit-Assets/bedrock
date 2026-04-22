-- Seed data: AIJI project (from Projects.tsx hardcoded data)
-- Uses deterministic UUIDs for stability. Idempotent via ON CONFLICT DO NOTHING.

-- Project
-- owner_email intentionally left NULL: fresh DBs render the "No owner — assign"
-- chip so an admin picks the real owner via the UI's Transfer flow. Avoids
-- baking a specific person into the seed (jp.dery@ was the old default and
-- caused picker-eligibility confusion because that email isn't in org_users).
INSERT INTO bedrock.project (id, name, description) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'AIJI', 'AI for Justice Initiative — strategic launch project')
ON CONFLICT DO NOTHING;

-- Workstreams
INSERT INTO bedrock.workstream (id, project_id, name, description, sort_order) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Strategy and Design', 'Core strategic framework and positioning for AIJI', 0),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Partnerships and Development', 'Building strategic partnerships and fundraising pipeline', 1),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001',
   'Communications and Narrative', 'Brand, messaging, and public communications', 2),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001',
   'Launch and Activation', 'Execution of launch plan and initial activation', 3)
ON CONFLICT DO NOTHING;

-- Milestones: Strategy and Design
INSERT INTO bedrock.milestone (id, workstream_id, title, status, priority, owner, description, sort_order) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001',
   'Finalize AIJI Operational Charter', 'On Track', 'Now', 'Leadership',
   'Draft and approve the AIJI charter with governance structure', 0),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
   'Revenue Model Design', 'At Risk', 'Now', 'Finance',
   'Define revenue streams, pricing, and sustainability model', 1)
ON CONFLICT DO NOTHING;

-- Milestones: Partnerships and Development
INSERT INTO bedrock.milestone (id, workstream_id, title, status, priority, owner, description, sort_order) VALUES
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002',
   'Anchor Investor Commitment', 'On Track', 'Now', 'Development', '', 0),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002',
   'Corporate Partnership Pipeline', 'Needs Attention', 'On-going', 'Development', '', 1)
ON CONFLICT DO NOTHING;

-- Milestones: Communications and Narrative
INSERT INTO bedrock.milestone (id, workstream_id, title, status, priority, owner, description, sort_order) VALUES
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003',
   'Brand Launch Materials', 'At Risk', 'Now', 'Communications', '', 0)
ON CONFLICT DO NOTHING;

-- Milestones: Launch and Activation
INSERT INTO bedrock.milestone (id, workstream_id, title, status, priority, owner, description, sort_order) VALUES
  ('c0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000004',
   'Soft Launch Event', 'On Track', 'Later', 'Events', '', 0)
ON CONFLICT DO NOTHING;

-- Tasks: Finalize AIJI Operational Charter
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
   'Draft charter document', 'Completed', 'Leadership', '2026-03-15', 0),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
   'Review with advisory board', 'In Progress', 'Leadership', '2026-03-28', 1),
  ('d0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001',
   'Incorporate feedback and finalize', 'Not Started', 'Leadership', '2026-04-05', 2)
ON CONFLICT DO NOTHING;

-- Tasks: Revenue Model Design
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000002',
   'Research comparable models', 'Completed', 'Finance', NULL, 0),
  ('d0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002',
   'Draft revenue projections', 'In Progress', 'Finance', '2026-04-01', 1),
  ('d0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000002',
   'Validate with key stakeholders', 'Not Started', 'Finance', '2026-04-15', 2)
ON CONFLICT DO NOTHING;

-- Tasks: Anchor Investor Commitment
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000003',
   'Identify top 10 anchor prospects', 'Completed', 'Development', NULL, 0),
  ('d0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000003',
   'Secure meetings with prospects', 'In Progress', 'Development', '2026-04-01', 1),
  ('d0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000003',
   'Negotiate and close first anchor', 'Not Started', 'Development', '2026-05-01', 2)
ON CONFLICT DO NOTHING;

-- Tasks: Corporate Partnership Pipeline
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-000000000004',
   'Build target list of 50 corporates', 'In Progress', 'Development', NULL, 0),
  ('d0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000004',
   'Create partnership deck', 'Not Started', 'Communications', '2026-04-15', 1)
ON CONFLICT DO NOTHING;

-- Tasks: Brand Launch Materials
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000005',
   'Design brand identity package', 'In Progress', 'Design', '2026-03-30', 0),
  ('d0000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000005',
   'Create launch website content', 'Not Started', 'Communications', '2026-04-10', 1),
  ('d0000000-0000-4000-8000-000000000014', 'c0000000-0000-4000-8000-000000000005',
   'Produce launch video', 'Not Started', 'Communications', '2026-04-20', 2)
ON CONFLICT DO NOTHING;

-- Tasks: Soft Launch Event
INSERT INTO bedrock.project_task (id, milestone_id, title, status, owner, deadline, sort_order) VALUES
  ('d0000000-0000-4000-8000-000000000015', 'c0000000-0000-4000-8000-000000000006',
   'Secure venue', 'Not Started', 'Events', '2026-05-01', 0),
  ('d0000000-0000-4000-8000-000000000016', 'c0000000-0000-4000-8000-000000000006',
   'Create invite list', 'Not Started', 'Events', '2026-05-10', 1),
  ('d0000000-0000-4000-8000-000000000017', 'c0000000-0000-4000-8000-000000000006',
   'Coordinate speakers', 'Not Started', 'Events', '2026-05-15', 2)
ON CONFLICT DO NOTHING;

-- Set depends_on for tasks that have dependencies
UPDATE bedrock.project_task SET depends_on = ARRAY['d0000000-0000-4000-8000-000000000002'::UUID]
WHERE id = 'd0000000-0000-4000-8000-000000000003' AND depends_on = '{}';

UPDATE bedrock.project_task SET depends_on = ARRAY['d0000000-0000-4000-8000-000000000005'::UUID]
WHERE id = 'd0000000-0000-4000-8000-000000000006' AND depends_on = '{}';

UPDATE bedrock.project_task SET depends_on = ARRAY['d0000000-0000-4000-8000-000000000008'::UUID]
WHERE id = 'd0000000-0000-4000-8000-000000000009' AND depends_on = '{}';

UPDATE bedrock.project_task SET depends_on = ARRAY['d0000000-0000-4000-8000-000000000012'::UUID]
WHERE id = 'd0000000-0000-4000-8000-000000000013' AND depends_on = '{}';

-- Set start_date for Gantt chart (7 days before deadline, or fallback)
UPDATE bedrock.project_task SET start_date = deadline - INTERVAL '7 days' WHERE deadline IS NOT NULL AND start_date IS NULL;
UPDATE bedrock.project_task SET start_date = '2026-03-01' WHERE deadline IS NULL AND start_date IS NULL;
