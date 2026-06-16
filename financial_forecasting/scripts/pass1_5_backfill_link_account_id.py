"""Pass 1.5 — backfill sf_account_id on bedrock.sf_contact_link rows that are
missing it. The bridge links public.contacts to SF Contacts, but ~88% of rows
never propagated the SF AccountId — meaning person-level activity can't roll
up to the account without an extra live SF query per email.

Process:
  1. Pull every sf_contact_link row where sf_account_id IS NULL.
  2. Batch-query SF Contacts by Id for AccountId + Account.Name (for the CSV).
  3. Propose an UPDATE setting sf_account_id = SF Contact.AccountId.

NOTE on Households: unlike the domain-map pass, we DO backfill Household accounts
here. A 1:1 link from a public.contact to a personal-donor's Household account is
semantically correct (their activity should roll up to that Household). Households
were excluded from the domain map because a domain-level mapping would fan that
single Household out across every employee at the same domain — a fan-out risk
that doesn't exist on a per-link row.

Dry-run by default. Pass --apply to commit. Always emits a CSV listing every
row processed (action: update / skip_household / skip_null_account / sf_missing).

Usage (from financial_forecasting/):
    python -m scripts.pass1_5_backfill_link_account_id           # dry-run
    python -m scripts.pass1_5_backfill_link_account_id --apply   # commit
"""
import argparse
import asyncio
import csv
import logging
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from simple_salesforce import Salesforce

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pass1_5_link_acct")

SOQL_CHUNK = 200  # SOQL IN-clause sweet spot; SF caps at much higher but 200 is fast


async def main(apply: bool, report_path: str) -> None:
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        logger.error("DATABASE_URL not set"); sys.exit(1)

    sf = Salesforce(
        username=os.getenv("SALESFORCE_USERNAME"),
        password=os.getenv("SALESFORCE_PASSWORD"),
        security_token=os.getenv("SALESFORCE_SECURITY_TOKEN", ""),
        domain=os.getenv("SALESFORCE_DOMAIN", "login"),
    )

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            """
            SELECT id, sf_contact_id, public_contact_id
            FROM bedrock.sf_contact_link
            WHERE sf_account_id IS NULL
              AND sf_contact_id IS NOT NULL
            """
        )
        logger.info("Found %d sf_contact_link rows missing sf_account_id", len(rows))
        sf_contact_ids = [r["sf_contact_id"] for r in rows]

        # Pull SF Contact -> Account info in chunks
        sf_lookup: dict[str, dict] = {}
        for i in range(0, len(sf_contact_ids), SOQL_CHUNK):
            chunk = sf_contact_ids[i : i + SOQL_CHUNK]
            id_list = ",".join(f"'{cid}'" for cid in chunk)
            res = sf.query_all(
                f"SELECT Id, AccountId, Account.Name, Account.Type "
                f"FROM Contact WHERE Id IN ({id_list})"
            )
            for rec in res.get("records", []):
                acct = rec.get("Account") or {}
                sf_lookup[rec["Id"]] = {
                    "account_id": rec.get("AccountId"),
                    "account_name": acct.get("Name") if isinstance(acct, dict) else None,
                    "account_type": acct.get("Type") if isinstance(acct, dict) else None,
                }
            logger.info("SF lookup progress: %d / %d", min(i + SOQL_CHUNK, len(sf_contact_ids)), len(sf_contact_ids))

        # Categorize. Keep link_id as the UUID object asyncpg gave us; stringify only for CSV.
        to_update = []   # list[(link_id_uuid, account_id, account_name)]
        skip_null_account = []
        sf_missing = []
        household_count = 0  # informational only — these are still updated

        for r in rows:
            link_id = r["id"]   # uuid.UUID
            sf_cid = r["sf_contact_id"]
            info = sf_lookup.get(sf_cid)
            if info is None:
                sf_missing.append((link_id, sf_cid))
                continue
            aid = info["account_id"]
            atype = info["account_type"] or ""
            aname = info["account_name"] or ""
            if not aid:
                skip_null_account.append((link_id, sf_cid))
                continue
            if atype == "Household" or "Household" in aname:
                household_count += 1
            to_update.append((link_id, aid, aname))

        logger.info(
            "Categorized — to_update=%d (of which %d are Households)  skip_null_account=%d  sf_missing=%d",
            len(to_update), household_count, len(skip_null_account), len(sf_missing),
        )

        # Write CSV (always)
        with open(report_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["action", "link_id", "sf_contact_id", "sf_account_id", "sf_account_name"])
            for lid, aid, aname in to_update:
                w.writerow(["update", str(lid), "", aid, aname])
            for lid, sf_cid in skip_null_account:
                w.writerow(["skip_null_account", str(lid), sf_cid, "", ""])
            for lid, sf_cid in sf_missing:
                w.writerow(["sf_missing", str(lid), sf_cid, "", ""])
        logger.info("Report written to %s", report_path)

        if not apply:
            print("\n=== DRY-RUN ===")
            print(f"  to update: {len(to_update)} ({household_count} are Households — donor 1:1 links, correct to set)")
            for lid, aid, aname in to_update[:15]:
                print(f"    {str(lid)[:8]}… → {aid} ({aname or '?'})")
            if len(to_update) > 15:
                print(f"    ... and {len(to_update) - 15} more")
            print(f"  skip_null_account: {len(skip_null_account)}  (SF Contact has no AccountId)")
            print(f"  sf_missing: {len(sf_missing)}  (SF Contact Id not found — possibly deleted)")
            print(f"\nRun with --apply to commit the {len(to_update)} updates.\n")
            return

        # Apply updates
        applied = 0
        async with conn.transaction():
            for lid, aid, _aname in to_update:
                await conn.execute(
                    "UPDATE bedrock.sf_contact_link SET sf_account_id = $1 WHERE id = $2 AND sf_account_id IS NULL",
                    aid, lid,
                )
                applied += 1
        total_with_acct = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.sf_contact_link WHERE sf_account_id IS NOT NULL"
        )
        logger.info("APPLIED %d updates. sf_contact_link rows with sf_account_id now: %d", applied, total_with_acct)
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--report", default="/tmp/pass1_5_link_account_backfill.csv")
    args = ap.parse_args()
    asyncio.run(main(args.apply, args.report))
