"""Seed bedrock.account_candidate + bedrock.contact_candidate from the existing
activity-scan tables.

The scan in scripts/scan_activity_universe.py has already done the hard work:
aggregating every external domain/email seen in the last N days of activity,
resolving against SF / public.* / sync_staff, and tagging each row with a
suggested_action. This script just promotes the scan rows that suggested_action
landed on 'candidate' or 'needs_backfill' into the funnel tables.

  activity_scan_domain (suggested_action IN ('candidate','needs_backfill'))
      → bedrock.account_candidate (one row per unique domain)

  activity_scan_person (suggested_action IN ('candidate','needs_backfill'))
      → bedrock.contact_candidate (one row per unique email)
      → contact_candidate.account_candidate_id linked to its domain's candidate
        OR contact_candidate.sf_account_id (denormalized) when the domain mapped

Idempotent — uses ON CONFLICT to merge counts on re-run.

Usage (from financial_forecasting/):
    python -m scripts.seed_candidate_funnel              # dry-run
    python -m scripts.seed_candidate_funnel --apply
"""
import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("seed_candidate_funnel")


async def main(apply: bool) -> None:
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        logger.error("DATABASE_URL not set"); sys.exit(1)

    conn = await asyncpg.connect(dsn)
    try:
        # Sanity-check: scan tables exist and are populated
        for tbl in ("activity_scan_domain", "activity_scan_person"):
            n = await conn.fetchval(f"SELECT COUNT(*) FROM bedrock.{tbl}")
            if n == 0:
                logger.error(
                    "%s is empty — run scripts.scan_activity_universe first", tbl
                )
                sys.exit(1)
            logger.info("bedrock.%s rows: %d", tbl, n)

        # --- account_candidate from activity_scan_domain ---
        domain_rows = await conn.fetch(
            """
            SELECT domain, first_seen_at, last_seen_at, activity_count,
                   distinct_people, source_breakdown, suggested_action,
                   resolved_via, public_company_id
            FROM bedrock.activity_scan_domain
            WHERE suggested_action IN ('candidate', 'needs_backfill')
            """
        )
        logger.info("account_candidate sources: %d scan rows", len(domain_rows))

        if not apply:
            print("\n=== DRY-RUN ===")
            print(f"  Would seed {len(domain_rows)} account_candidate rows")
            person_rows = await conn.fetch(
                """
                SELECT email, domain, first_seen_at, last_seen_at, activity_count,
                       suggested_action, resolved_sf_account_id, resolved_public_contact_id
                FROM bedrock.activity_scan_person
                WHERE suggested_action IN ('candidate', 'needs_backfill')
                """
            )
            print(f"  Would seed {len(person_rows)} contact_candidate rows")
            print("\nRun with --apply to commit.\n")
            return

        # Pick a first_source by examining source_breakdown JSONB (gmail-sync vs calendar-sync)
        applied_accts = 0
        async with conn.transaction():
            for r in domain_rows:
                raw_breakdown = r["source_breakdown"]
                if isinstance(raw_breakdown, str):
                    try:
                        breakdown = json.loads(raw_breakdown)
                    except (TypeError, ValueError):
                        breakdown = {}
                else:
                    breakdown = raw_breakdown or {}
                # Highest-count source wins
                if breakdown:
                    first_source = max(breakdown.items(), key=lambda kv: kv[1])[0]
                else:
                    first_source = "scan_seed"
                # If a public.companies match exists from the scan, denormalize
                pc_id = r["public_company_id"]

                await conn.execute(
                    """
                    INSERT INTO bedrock.account_candidate (
                        primary_domain, first_seen_at, last_seen_at, first_source,
                        signal_count, unique_people, public_company_id, status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7,
                              CASE WHEN $8 = 'needs_backfill' THEN 'tracking' ELSE 'new' END)
                    ON CONFLICT (primary_domain) DO UPDATE SET
                        last_seen_at  = GREATEST(bedrock.account_candidate.last_seen_at, EXCLUDED.last_seen_at),
                        first_seen_at = LEAST   (bedrock.account_candidate.first_seen_at, EXCLUDED.first_seen_at),
                        signal_count  = EXCLUDED.signal_count,
                        unique_people = EXCLUDED.unique_people,
                        public_company_id = COALESCE(bedrock.account_candidate.public_company_id, EXCLUDED.public_company_id),
                        updated_at    = now()
                    """,
                    r["domain"].lower(), r["first_seen_at"], r["last_seen_at"],
                    first_source, r["activity_count"], r["distinct_people"], pc_id,
                    r["suggested_action"],
                )
                applied_accts += 1
        logger.info("Upserted %d account_candidate rows", applied_accts)

        # --- contact_candidate from activity_scan_person ---
        person_rows = await conn.fetch(
            """
            SELECT email, domain, first_seen_at, last_seen_at, activity_count,
                   suggested_action, resolved_sf_account_id, resolved_public_contact_id
            FROM bedrock.activity_scan_person
            WHERE suggested_action IN ('candidate', 'needs_backfill')
            """
        )
        logger.info("contact_candidate sources: %d scan rows", len(person_rows))

        # Build domain → account_candidate.id lookup
        acct_rows = await conn.fetch(
            "SELECT id, primary_domain FROM bedrock.account_candidate"
        )
        domain_to_cand_id = {r["primary_domain"]: r["id"] for r in acct_rows}

        # Also pull domain → SF Account id mapping for cases where the person's
        # domain IS mapped (so the person's contact_candidate.sf_account_id can be
        # set even when no account_candidate exists for that domain).
        aed_rows = await conn.fetch(
            "SELECT domain, sf_account_id FROM bedrock.account_email_domain"
        )
        domain_to_sf_acct = {r["domain"].lower(): r["sf_account_id"] for r in aed_rows}

        applied_contacts = 0
        async with conn.transaction():
            for r in person_rows:
                email = r["email"].lower()
                domain = (r["domain"] or "").lower()
                acct_cand_id = domain_to_cand_id.get(domain)
                sf_acct_id = r["resolved_sf_account_id"] or domain_to_sf_acct.get(domain)
                pc_id = r["resolved_public_contact_id"]

                await conn.execute(
                    """
                    INSERT INTO bedrock.contact_candidate (
                        email, first_seen_at, last_seen_at, first_source,
                        signal_count, account_candidate_id, sf_account_id,
                        public_contact_id, status
                    ) VALUES ($1, $2, $3, 'scan_seed', $4, $5, $6, $7,
                              CASE WHEN $8 = 'needs_backfill' THEN 'tracking' ELSE 'new' END)
                    ON CONFLICT (email) DO UPDATE SET
                        last_seen_at         = GREATEST(bedrock.contact_candidate.last_seen_at, EXCLUDED.last_seen_at),
                        first_seen_at        = LEAST   (bedrock.contact_candidate.first_seen_at, EXCLUDED.first_seen_at),
                        signal_count         = EXCLUDED.signal_count,
                        account_candidate_id = COALESCE(bedrock.contact_candidate.account_candidate_id, EXCLUDED.account_candidate_id),
                        sf_account_id        = COALESCE(bedrock.contact_candidate.sf_account_id, EXCLUDED.sf_account_id),
                        public_contact_id    = COALESCE(bedrock.contact_candidate.public_contact_id, EXCLUDED.public_contact_id),
                        updated_at           = now()
                    """,
                    email, r["first_seen_at"], r["last_seen_at"],
                    r["activity_count"], acct_cand_id, sf_acct_id, pc_id,
                    r["suggested_action"],
                )
                applied_contacts += 1
        logger.info("Upserted %d contact_candidate rows", applied_contacts)

        # Final tallies
        acct_total = await conn.fetchval("SELECT COUNT(*) FROM bedrock.account_candidate")
        contact_total = await conn.fetchval("SELECT COUNT(*) FROM bedrock.contact_candidate")
        contacts_at_mapped = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.contact_candidate WHERE sf_account_id IS NOT NULL"
        )
        contacts_at_acct_cand = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.contact_candidate WHERE account_candidate_id IS NOT NULL"
        )
        print(f"\n=== Funnel seeded ===")
        print(f"  account_candidate total: {acct_total}")
        print(f"  contact_candidate total: {contact_total}")
        print(f"    of those, at a MAPPED SF Account (quick-win promotions): {contacts_at_mapped}")
        print(f"    of those, linked to an account_candidate:               {contacts_at_acct_cand}")
        print()
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(args.apply))
