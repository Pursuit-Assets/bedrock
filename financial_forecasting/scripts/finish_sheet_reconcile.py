"""Finish the sheet reconcile: create the 6 held-back opportunities (per user
review), close Food Education Fund, and link Fund for the City of New York's
second contact. Idempotent.

  python -m scripts.finish_sheet_reconcile           # DRY RUN
  python -m scripts.finish_sheet_reconcile --commit
"""
import argparse
import asyncio
import os

from dotenv import load_dotenv

# (account_name, account_id, owner_email, stage, source, contact_id, note)
NEW_OPPS = [
    ("Ballistic Ventures", "0011U00001xbh6vQAA", "devika@pursuit.org", "initial_outreach", "sheet_import (Dan Teran)", 15100),
    ("Pursuit Transformation Company", "UNKNOWN", "david@pursuit.org", "initial_outreach", "sheet_import", None),
    ("GT Edge AI", "UNKNOWN", "david@pursuit.org", "initial_outreach", "prior engagement", None),
    ("PDP", "UNKNOWN", "david@pursuit.org", "initial_outreach", "sheet_import (PDP [DY])", None),
    ("MMoser", "UNKNOWN", "david@pursuit.org", "initial_outreach", "sheet_import (M Moser [DY] — verify SF acct)", None),
    ("Board (placeholder)", "UNKNOWN", "nick@pursuit.org", "initial_outreach", "sheet_import (placeholder)", None),
]


async def main(commit: bool):
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    existing = {r["k"] for r in await conn.fetch(
        "SELECT lower(trim(account_name)) k FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL")}

    print("=== new opps ===")
    todo = [o for o in NEW_OPPS if o[0].strip().lower() not in existing]
    for o in todo:
        print(f"  {o[0]:32} owner={o[2]:22} stage={o[3]} contact={o[5] or '-'}")
    print(f"  ({len(NEW_OPPS) - len(todo)} already exist, skipped)")

    fef = await conn.fetchrow("SELECT id, stage FROM bedrock.jobs_opportunity WHERE lower(trim(account_name))='food education fund' AND deleted_at IS NULL")
    print(f"\nFood Education Fund: {fef['stage'] if fef else 'NOT FOUND'} -> closed_lost (Not interested)")

    ffcny = await conn.fetchrow("SELECT id, sf_contact_ids FROM bedrock.jobs_opportunity WHERE lower(trim(account_name))='fund for the city of new york' AND deleted_at IS NULL")
    has_jill = ffcny and "pub:16718" in (ffcny["sf_contact_ids"] or [])
    print(f"FFCNY link Jill Borrero (#16718): {'already linked' if has_jill else 'will add'}")

    if not commit:
        print("\nDRY RUN — nothing written.")
        await conn.close(); return

    async with conn.transaction():
        for name, acct_id, owner, stage, source, cid in todo:
            sf_ids = [f"pub:{cid}"] if cid else []
            if cid:
                await conn.execute("UPDATE public.contacts SET is_jobs_contact=true WHERE contact_id=$1", cid)
            await conn.execute(
                """INSERT INTO bedrock.jobs_opportunity
                       (account_id, account_name, stage, deal_type, owner_email, sf_contact_ids, source)
                   VALUES ($1, $2, $3, 'ft', $4, $5, $6)""",
                acct_id, name, stage, owner, sf_ids, source)
        if fef and fef["stage"] != "closed_lost":
            await conn.execute(
                "UPDATE bedrock.jobs_opportunity SET stage='closed_lost', closed_lost_reason=$2, closed_at=now() WHERE id=$1",
                fef["id"], "Not interested (per pipeline sheet)")
        if ffcny and not has_jill:
            await conn.execute("UPDATE public.contacts SET is_jobs_contact=true WHERE contact_id=16718")
            await conn.execute(
                "UPDATE bedrock.jobs_opportunity SET sf_contact_ids = array_append(coalesce(sf_contact_ids,'{}'), 'pub:16718') WHERE id=$1",
                ffcny["id"])
    print(f"\nDONE: created {len(todo)} opps, closed FEF, linked Jill.")
    await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    load_dotenv()
    asyncio.run(main(args.commit))
