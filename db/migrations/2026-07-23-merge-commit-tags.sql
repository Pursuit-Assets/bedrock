-- Merge commit_company into prior_commit_partner, redefined as "people at a
-- company where we had commit hires" (2026-07-23, Jac's list). Everyone else in
-- the commit_company ∪ prior_commit_partner set → other_hiring_partner.
-- commit_company tag retired (deactivated). Idempotent.
-- Commit-hire companies: Blackstone(+Cyber/BXMA), Citi, Moody's, Uber, Ballistic,
-- Citizens, iCapital, Red Canary, David Energy, Foursquare, Peloton, Poll
-- Everywhere, Quizlet, SeatGeek, Sift, Skillshare, Spring Health, Thirty Madison,
-- Thumbtack, TKWW/The Knot, Cedar, Dwolla, Ribbon, JP Morgan.
\set commit_re '^(blackstone|citi($|group|bank|[[:space:]])|citizens|moody|uber($|,|[[:space:]])|ballistic|icapital|red canary|david energy|foursquare|peloton|poll everywhere|quizlet|seatgeek|sift($|[[:space:]])|skillshare|spring health|thirty madison|thumbtack|tkww|the knot|cedar|dwolla|ribbon|j\\.?p\\.?[[:space:]]*morgan|jpmorgan)'

-- A. commit-hire companies → prior_commit_partner (drop commit_company)
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_remove(coalesce(c.tags,'{}'::text[]),'commit_company') || ARRAY['prior_commit_partner']) t ORDER BY t), updated_at=now()
WHERE ('commit_company'=ANY(c.tags) OR 'prior_commit_partner'=ANY(c.tags))
  AND lower(trim(c.current_company)) ~* :'commit_re';

-- B. everyone else in the set → other_hiring_partner (drop commit_company + prior_commit_partner)
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_remove(array_remove(coalesce(c.tags,'{}'::text[]),'commit_company'),'prior_commit_partner') || ARRAY['other_hiring_partner']) t ORDER BY t), updated_at=now()
WHERE ('commit_company'=ANY(c.tags) OR 'prior_commit_partner'=ANY(c.tags))
  AND (c.current_company IS NULL OR NOT (lower(trim(c.current_company)) ~* :'commit_re'));

-- C. retire the commit_company tag from the catalog
UPDATE bedrock.contact_tag_catalog SET active=false WHERE slug='commit_company';
