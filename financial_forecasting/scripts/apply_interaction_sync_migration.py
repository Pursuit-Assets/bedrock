"""Apply 2026-05-22-add-interaction-sync.sql migration.

Usage (from financial_forecasting/):
    python -m scripts.apply_interaction_sync_migration

Requires DATABASE_URL in environment or .env.
"""

import asyncio
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

load_dotenv(override=False)


async def main():
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        sys.exit(1)

    migration = (
        Path(__file__).parent.parent
        / "db"
        / "migrations"
        / "2026-05-22-add-interaction-sync.sql"
    )
    sql = migration.read_text()

    print(f"Applying: {migration.name}")
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(sql)
        print("Done.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
