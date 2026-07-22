-- Re-scope volunteer_current to 12-month recency (2026-07-22, Jac).
-- Salesforce's real volunteer-date field (GW_Volunteers__Last_Volunteer_Date__c)
-- ended 2021, so "last volunteered in 12 months" uses SF Last_Activity_Date
-- within 12mo among Volunteer__c=true contacts (the only live recency signal) —
-- the same proxy the sheet used at 18mo. The 74 SF-current emails are embedded
-- below (SF query: Volunteer__c=true AND Last_Activity_Date__c >= 2025-07-22).
-- Among volunteer-tagged contacts: those emails → volunteer_current, all others
-- → volunteer_historical. Idempotent.

CREATE TEMP TABLE _vol_current(email text);
INSERT INTO _vol_current(email) VALUES
  ('daniel.p.teran@gmail.com'),
  ('adam.belanich@gmail.com'),
  ('anjali@pdtpartners.com'),
  ('katy.knight@siegelendowment.org'),
  ('richard.siu@fandtgroup.com'),
  ('pia.s.desai@gmail.com'),
  ('zyardeni@gmail.com'),
  ('efuquen@google.com'),
  ('margot.edelman@edelman.com'),
  ('jukay@pursuit.org'),
  ('yong@pursuit.org'),
  ('zac@joecompany.com'),
  ('david.drew@blackstone.com'),
  ('dilorenzo.christopher@gmail.com'),
  ('chris@floornfts.io'),
  ('christopher.lemoine@citi.com'),
  ('joe@fabisevi.ch'),
  ('john.rodriguez@gmail.com'),
  ('marleycalford@gmail.com'),
  ('mail@jorgetorres.com'),
  ('madhu_lists@yahoo.com'),
  ('anthonysgeranio@gmail.com'),
  ('rod@foveacentral.com'),
  ('hasani.blackwell@gmail.com'),
  ('rusili56@gmail.com'),
  ('heriberto.uroza813@gmail.com'),
  ('segacyroberts@gmail.com'),
  ('qiansan@gmail.com'),
  ('mani.ramezan@gmail.com'),
  ('jess10236@gmail.com'),
  ('matt@polleverywhere.com'),
  ('sjkaplan@google.com'),
  ('guilherme251187@gmail.com'),
  ('dsmirniotis@gmail.com'),
  ('dave@pursuit.org'),
  ('jumi.barnes@gs.com'),
  ('randyclinton@gmail.com'),
  ('spr3adsh33tsido@gmail.com'),
  ('hgkim@google.com'),
  ('mateo@polleverywhere.com'),
  ('alexander.atallah@gmail.com'),
  ('alex.elios@gmail.com'),
  ('daniel.adeyanju@gmail.com'),
  ('stefano@pursuit.org'),
  ('langenbergkeith@gmail.com'),
  ('rsubramanian@maycombcapital.com'),
  ('aaronburchamheisler@gmail.com'),
  ('bheckman013@gmail.com'),
  ('jschulhof@edc.nyc'),
  ('jonna.l.gilmore@citizensbank.com'),
  ('wilsonk1@coned.com'),
  ('alyssa.fletcher@blackstone.com'),
  ('kanan.kapadia@gmail.com'),
  ('nicole.revanales@mizuhogroup.com'),
  ('nuno.m.dossantos@citizensbank.com'),
  ('azka.sohail@elastic.co'),
  ('sarah_walker@live.com'),
  ('shaleena.campbell@capitalone.com'),
  ('djriefler@gmail.com'),
  ('e.lissroy@yahoo.com'),
  ('karoline27x@gmail.com'),
  ('paul.sangree@macquarie.com'),
  ('mmaclachlan@google.com'),
  ('sstarpoli@etsy.com'),
  ('robindra.mahabir@pnc.com'),
  ('asglaser@gmail.com'),
  ('rivase@coned.com'),
  ('girijarajan@gmail.com'),
  ('adjaniants@metlife.com'),
  ('teicher.michael@gmail.com'),
  ('daguevara8688@gmail.com'),
  ('nick@pursuit.org'),
  ('satishksp@yahoo.com'),
  ('gregh@pursuit.org');

-- promote the current set (add current, drop historical)
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_remove(coalesce(c.tags,'{}'::text[]),'volunteer_historical') || ARRAY['volunteer_current']) t ORDER BY t),
    updated_at = now()
WHERE lower(c.email) IN (SELECT email FROM _vol_current)
  AND (coalesce(c.tags,'{}'::text[]) && ARRAY['volunteer_current','volunteer_historical']);

-- demote everyone else who was volunteer-tagged (drop current, add historical)
UPDATE public.contacts c
SET tags = ARRAY(SELECT DISTINCT t FROM unnest(array_remove(coalesce(c.tags,'{}'::text[]),'volunteer_current') || ARRAY['volunteer_historical']) t ORDER BY t),
    updated_at = now()
WHERE 'volunteer_current' = ANY(coalesce(c.tags,'{}'::text[]))
  AND lower(c.email) NOT IN (SELECT email FROM _vol_current);
