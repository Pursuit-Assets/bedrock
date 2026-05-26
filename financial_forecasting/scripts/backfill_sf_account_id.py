"""Backfill sf_account_id on bedrock.sf_contact_link for existing matched contacts.

Queries SF for each matched contact's Primary Affiliation employer account ID
and writes it to sf_contact_link.sf_account_id. Safe to re-run (idempotent).

Usage (from financial_forecasting/):
    python -m scripts.backfill_sf_account_id [--dry-run]
"""

import asyncio
import logging
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

DRY_RUN = "--dry-run" in sys.argv


async def main():
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    conn = await asyncpg.connect(dsn)

    # Get all matched contacts that are missing sf_account_id
    rows = await conn.fetch(
        "SELECT sf_contact_id FROM bedrock.sf_contact_link WHERE sf_account_id IS NULL"
    )
    sf_ids = [r["sf_contact_id"] for r in rows]
    logger.info("%d contacts to backfill", len(sf_ids))

    if not sf_ids:
        print("Nothing to backfill.")
        await conn.close()
        return

    # Import SF client via the running server's auth pattern
    from simple_salesforce import Salesforce
    sf = Salesforce(
        username=os.getenv("SALESFORCE_USERNAME"),
        password=os.getenv("SALESFORCE_PASSWORD"),
        security_token=os.getenv("SALESFORCE_SECURITY_TOKEN", ""),
        domain=os.getenv("SALESFORCE_DOMAIN", "login"),
    )

    updated = 0
    missing = 0
    errors = 0

    # Process in batches of 200 (SOQL IN clause limit)
    batch_size = 200
    for i in range(0, len(sf_ids), batch_size):
        batch = sf_ids[i:i + batch_size]
        id_list = "', '".join(batch)
        # Query the Affiliation object directly — Contact relationship traversal
        # (Primary_Affiliation__r) is not exposed in this org's API.
        try:
            result = sf.query_all(
                f"SELECT npe5__Contact__c, Account_ForFellowsOnly__c "
                f"FROM npe5__Affiliation__c "
                f"WHERE npe5__Primary__c = true "
                f"AND npe5__Contact__c IN ('{id_list}')"
            )
        except Exception as e:
            logger.error("SF query failed for batch %d: %s", i // batch_size, e)
            errors += len(batch)
            continue

        for c in result.get("records", []):
            sf_contact_id = c.get("npe5__Contact__c")
            account_id = c.get("Account_ForFellowsOnly__c")

            if not account_id:
                missing += 1
                continue

            if DRY_RUN:
                logger.info("would set %s → account %s", sf_contact_id, account_id)
                updated += 1
                continue

            try:
                await conn.execute(
                    "UPDATE bedrock.sf_contact_link SET sf_account_id = $1 WHERE sf_contact_id = $2",
                    account_id,
                    sf_contact_id,
                )
                updated += 1
            except Exception as e:
                logger.warning("update failed for %s: %s", sf_contact_id, e)
                errors += 1

        logger.info("batch %d/%d done", i // batch_size + 1, (len(sf_ids) + batch_size - 1) // batch_size)

    print(f"\nDone. updated={updated} no_affiliation={missing} errors={errors}")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
