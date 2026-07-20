#!/usr/bin/env python3
"""Apply the SERP-verified PE/VC industry labels to public.companies.

Source: ~/Desktop/pevc_classification_review.csv (1,007 candidates researched
via live web search + Haiku adjudication, July 2026). Writes ONLY rows labeled
venture_capital / private_equity / vc_and_pe at HIGH confidence (~341).

Safety: saves the touched rows' current values to
~/Desktop/pevc_writeback_rollback.json before updating. Stamps
enrichment_source='serp_verified_pevc_v1' so the pass is auditable.
"""
import asyncio, asyncpg, re, json, csv, os

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", ".env")
url = [re.match(r"DATABASE_URL=(.+)", l.strip()).group(1).strip().strip('"').strip("'")
       for l in open(ENV) if l.startswith("DATABASE_URL=")][0]

LABEL = {
    "venture_capital": "Venture Capital",
    "private_equity": "Private Equity",
    "vc_and_pe": "Venture Capital & Private Equity",
}
CSV = os.path.expanduser("~/Desktop/pevc_classification_review.csv")
ROLLBACK = os.path.expanduser("~/Desktop/pevc_writeback_rollback.json")

rows = list(csv.DictReader(open(CSV)))
hits = [r for r in rows if r["new_label"] in LABEL and r["confidence"] == "high"]
print(f"writing {len(hits)} high-confidence labels")


async def main():
    conn = await asyncpg.connect(url)
    ids = [int(r["company_id"]) for r in hits]
    cur = await conn.fetch(
        "SELECT company_id, name, industry, enrichment_source FROM public.companies WHERE company_id = ANY($1)", ids)
    json.dump([dict(r) for r in cur], open(ROLLBACK, "w"), default=str)
    print(f"rollback file: {ROLLBACK} ({len(cur)} rows)")
    n = 0
    for lbl, industry in LABEL.items():
        batch = [int(r["company_id"]) for r in hits if r["new_label"] == lbl]
        if not batch:
            continue
        res = await conn.execute(
            """UPDATE public.companies
               SET industry = $1, enrichment_source = 'serp_verified_pevc_v1',
                   enriched_at = now(), updated_at = now()
               WHERE company_id = ANY($2)""", industry, batch)
        c = int(res.split()[-1]); n += c
        print(f"  {industry}: {c}")
    after = await conn.fetch(
        """SELECT industry, count(*) FROM public.companies
           WHERE industry IN ('Venture Capital','Private Equity','Venture Capital & Private Equity')
           GROUP BY 1 ORDER BY 2 DESC""")
    print("in DB now:", [dict(r) for r in after], f"— rows updated: {n}")
    await conn.close()

asyncio.run(main())
