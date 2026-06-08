"""One-shot parallel backfill of Gmail + Calendar activity for every enabled
sync_staff member. Use after adding new staff to skip the wait-for-nightly path.

Concurrency capped to keep us under Gmail's per-project quota and to avoid
exhausting the segundo-db connection pool. Each staff member runs Gmail and
Calendar sequentially within their slot — both call out to Google for that
same mailbox, and the DWD impersonation is per-mailbox anyway.

Run from financial_forecasting/:
    python -m scripts.parallel_staff_backfill --concurrency 8 --days-back 90

Idempotent — repeated runs catch up from the watermark, they don't re-fetch.
"""
import argparse
import asyncio
import logging
import os
import sys
import time
from dotenv import load_dotenv

# Make the financial_forecasting/ root importable so 'services.*' resolves
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
logger = logging.getLogger('parallel_staff_backfill')

import asyncpg
from services.gmail_sync import sync_gmail_for_staff
from services.calendar_sync import sync_calendar_for_staff
from services.google_dwd import is_dwd_configured


async def sync_one_staff(pool, sem: asyncio.Semaphore, email: str, days_back: int) -> dict:
    """Sync Gmail then Calendar for a single staff member. Returns summary dict."""
    async with sem:
        result = {'email': email}
        async with pool.acquire() as conn:
            try:
                t0 = time.monotonic()
                gmail = await sync_gmail_for_staff(conn, email, days_back=days_back)
                gmail['secs'] = round(time.monotonic() - t0, 1)
                result['gmail'] = gmail
                logger.info("gmail %s: upserted=%d errors=%d in %ss",
                            email, gmail.get('upserted', 0),
                            gmail.get('errors', 0), gmail.get('secs'))
            except Exception as e:
                logger.error("gmail FAIL %s: %s", email, e)
                result['gmail'] = {'error': str(e)}
            try:
                t0 = time.monotonic()
                cal = await sync_calendar_for_staff(conn, email, days_back=days_back)
                cal['secs'] = round(time.monotonic() - t0, 1)
                result['calendar'] = cal
                logger.info("calendar %s: upserted=%d errors=%d in %ss",
                            email, cal.get('upserted', 0),
                            cal.get('errors', 0), cal.get('secs'))
            except Exception as e:
                logger.error("calendar FAIL %s: %s", email, e)
                result['calendar'] = {'error': str(e)}
        return result


async def main(concurrency: int, days_back: int) -> None:
    if not is_dwd_configured():
        logger.error("GOOGLE_SERVICE_ACCOUNT_JSON not set — aborting")
        sys.exit(1)

    db_url = os.environ.get('DATABASE_URL')
    if not db_url:
        logger.error("DATABASE_URL not set")
        sys.exit(1)

    pool = await asyncpg.create_pool(db_url, min_size=2, max_size=max(concurrency + 2, 4))
    try:
        rows = await pool.fetch(
            "SELECT email FROM bedrock.sync_staff WHERE enabled = true ORDER BY email"
        )
        staff = [r['email'] for r in rows]
        logger.info("syncing %d staff at concurrency=%d, days_back=%d",
                    len(staff), concurrency, days_back)

        sem = asyncio.Semaphore(concurrency)
        t0 = time.monotonic()
        results = await asyncio.gather(
            *(sync_one_staff(pool, sem, email, days_back) for email in staff),
            return_exceptions=False,
        )
        elapsed = round(time.monotonic() - t0, 1)
        total_gmail = sum(r.get('gmail', {}).get('upserted', 0) for r in results)
        total_cal = sum(r.get('calendar', {}).get('upserted', 0) for r in results)
        errors = sum(
            1 for r in results
            if r.get('gmail', {}).get('error') or r.get('calendar', {}).get('error')
        )
        logger.info(
            "DONE — %d staff in %ss · gmail upserted=%d · calendar upserted=%d · errors=%d",
            len(results), elapsed, total_gmail, total_cal, errors,
        )
    finally:
        await pool.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--concurrency', type=int, default=8,
                    help='Max concurrent staff syncs (default 8)')
    ap.add_argument('--days-back', type=int, default=90,
                    help='Backfill window for first-time syncs (default 90)')
    args = ap.parse_args()
    asyncio.run(main(args.concurrency, args.days_back))
