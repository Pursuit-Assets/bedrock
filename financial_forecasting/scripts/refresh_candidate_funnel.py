"""Refresh the candidate funnel — one-shot wrapper that re-runs scan +
seed sequentially. Designed to run nightly via cron / Cloud Scheduler.

Both underlying scripts are idempotent:
  - scan_activity_universe.py   TRUNCATEs activity_scan_* tables and rebuilds
                                from current bedrock.activity (now uses UPSERT
                                so partial failures are safe).
  - seed_candidate_funnel.py    UPSERTs candidate rows; signal_count + dates
                                refresh, status is left alone on existing rows
                                (so already-reviewed candidates aren't reverted).

Why not wire the sync services directly: gmail_sync + calendar_sync each ingest
~50 staff × ~hundreds of messages/day, and modifying their inserts to also
resolve + upsert candidates is a hot-path change touching the whole sync
pipeline. A nightly batch refresh achieves the same end-state with far less
risk — and the lag (worst case ~24h before a new candidate appears in the
funnel) is acceptable for human triage.

Usage (from financial_forecasting/):
    python -m scripts.refresh_candidate_funnel
"""
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("refresh_candidate_funnel")

from scripts.scan_activity_universe import main as scan_main
from scripts.seed_candidate_funnel import main as seed_main


async def run() -> None:
    logger.info("=== Step 1: scan_activity_universe ===")
    await scan_main(since_days=None)  # use full activity history
    logger.info("=== Step 2: seed_candidate_funnel ===")
    await seed_main(apply=True)
    logger.info("=== Done ===")


if __name__ == "__main__":
    asyncio.run(run())
