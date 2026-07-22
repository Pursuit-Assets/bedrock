-- Influence tags (2026-07-22): decision-maker targeting.
--   influence            = chief-level title (any "Chief … Officer", Chief of
--                          Staff, or CEO/CTO/COO/CFO/CMO/CIO/CISO/CHRO/CRO/CPO/
--                          CLO/CDO), excluding assistant/advisor/analyst/bureau/
--                          branch/"to the <exec>" support roles.
--   fast_local_influence = influence AND company <500 employees (size_bucket
--                          1-10/11-50/51-200) AND HQ in the tri-state area
--                          (NY/NJ/CT).
-- Adds tags only; does NOT change is_jobs_contact (the recuration rule would
-- fold these in on its next run — deliberately not run here). Idempotent.

INSERT INTO bedrock.contact_tag_catalog (slug, label, sort_order) VALUES
  ('influence',            'Influence',            130),
  ('fast_local_influence', 'Fast Local Influence', 131)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- influence
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(coalesce(c.tags,'{}'::text[]) || ARRAY['influence']) t ORDER BY t),
    updated_at = now()
WHERE c.current_title ~* '(chief\s+(executive|operating|technology|financial|marketing|information|revenue|people|data|product|strategy|legal|security|of\s+staff|human)|\m(CEO|CTO|COO|CFO|CMO|CIO|CISO|CHRO|CRO|CPO|CLO|CDO)\M)'
  AND c.current_title !~* '(assistant|advisor|analyst|associate|\mintern\M|coordinator|to\s+the\s+(ceo|coo|cto|cfo|president|founder|chief)|office\s+of\s+the|bureau|branch|party|acreage)'
  AND NOT ('influence' = ANY(coalesce(c.tags,'{}'::text[])));

-- fast_local_influence (subset: small + tri-state)
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(coalesce(c.tags,'{}'::text[]) || ARRAY['fast_local_influence']) t ORDER BY t),
    updated_at = now()
FROM public.companies co
WHERE co.company_id = c.company_id
  AND 'influence' = ANY(coalesce(c.tags,'{}'::text[]))
  AND co.size_bucket IN ('1-10','11-50','51-200')
  AND co.hq_location ~ ',\s*(NY|NJ|CT)$'
  AND NOT ('fast_local_influence' = ANY(coalesce(c.tags,'{}'::text[])));
