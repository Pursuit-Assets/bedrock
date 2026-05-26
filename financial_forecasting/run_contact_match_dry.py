"""Standalone dry-run of the SF Contact → public.contacts matcher.

Run from financial_forecasting/:
    python run_contact_match_dry.py
"""
import asyncio
import os
import sys

import asyncpg
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, os.path.dirname(__file__))

from mcp_client import UnifiedMCPClient
from services.sf_contact_matcher import match_all_contacts


async def main():
    database_url = os.environ["DATABASE_URL"]
    conn = await asyncpg.connect(database_url)

    client = UnifiedMCPClient()
    await client.connect_salesforce(None)
    sf = client.salesforce

    print("Running dry-run scan (limit=2000)…")
    summary = await match_all_contacts(sf, conn, limit=2000, dry_run=True)
    print("\n=== Dry-run summary ===")
    for k, v in summary.items():
        print(f"  {k}: {v}")

    await conn.close()
    await client.disconnect_all()


if __name__ == "__main__":
    asyncio.run(main())
