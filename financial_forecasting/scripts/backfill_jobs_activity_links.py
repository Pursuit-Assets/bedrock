"""One-off backfill: flag jobs-team-engaged contacts, then FULL relink of
activity → jobs prospects (closes the gap left by the window-bounded nightly run
and links freshly-synced activity).

Safe + idempotent: relink only UPDATEs rows where participant_public_contact_id
IS NULL; auto-flag only flips contacts the jobs team actually engaged. Uses the
app role (DATABASE_URL) — these are the same writes the nightly sync performs.

Usage (from financial_forecasting/):
    python -m scripts.backfill_jobs_activity_links
"""
import asyncio
import os

from dotenv import load_dotenv


async def main() -> None:
    import asyncpg
    from services.jobs_activity_link import (
        relink_jobs_prospect_activity,
        auto_flag_jobs_prospects,
    )

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        before = await conn.fetchval(
            "SELECT count(*) FROM bedrock.activity WHERE participant_public_contact_id IS NOT NULL"
        )
        print(f"linked activity BEFORE: {before}")

        flag = await auto_flag_jobs_prospects(conn)
        print(f"auto_flag_jobs_prospects: {flag}")

        link = await relink_jobs_prospect_activity(conn, days_back=None)  # full backfill
        print(f"relink (full): {link}")

        after = await conn.fetchval(
            "SELECT count(*) FROM bedrock.activity WHERE participant_public_contact_id IS NOT NULL"
        )
        print(f"linked activity AFTER:  {after}  (net +{after - before})")
    finally:
        await conn.close()


if __name__ == "__main__":
    load_dotenv()
    asyncio.run(main())
