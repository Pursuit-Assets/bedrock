"""Pass 1 step 2 — backfill bedrock.account_email_domain from SF Contact emails.

Companion to seed_account_email_domains.py:
  - seed_account_email_domains.py handles SF Account.Website + public.contacts.
  - This script pulls SF Contacts directly (Email + AccountId) and proposes new
    domain → account mappings the website pass missed.

Conservative posture (per tasks/data-cleanup-pass.md Pass 1):
  - Free-mail domains (gmail, yahoo, etc.) → skipped.
  - Domain already mapped to the same AccountId → no-op.
  - Domain already mapped to a DIFFERENT AccountId → CONFLICT (logged, not overwritten).
  - Domain with SF Contacts on multiple AccountIds → CONFLICT (logged, not auto-linked).
  - Domain with SF Contacts on exactly one AccountId, not yet mapped → propose insert.

Dry-run by default. Pass --apply to commit. Always emits a CSV of conflicts.

Usage (from financial_forecasting/):
    python -m scripts.pass1_sf_contact_domain_backfill           # dry-run
    python -m scripts.pass1_sf_contact_domain_backfill --apply   # commit inserts
    python -m scripts.pass1_sf_contact_domain_backfill --apply --report /tmp/conflicts.csv
"""
import argparse
import asyncio
import csv
import logging
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import asyncpg
from dotenv import load_dotenv
from simple_salesforce import Salesforce

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pass1_sf_contacts")

# Same blocklist as seed_account_email_domains.py — free-mail / known internal
BLOCKLIST = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "aol.com", "mail.com", "live.com", "msn.com", "googlemail.com",
    "protonmail.com", "me.com", "mac.com",
    "pursuit.org", "pursuit.com", "pursuitnyc.org",
    "coalitionforqueens.org", "c4q.nyc", "ac.c4q.nyc",
}


def domain_from_email(email: str) -> str | None:
    if not email or "@" not in email:
        return None
    domain = email.split("@", 1)[1].strip().lower()
    domain = re.sub(r"^www\.", "", domain)
    return domain if "." in domain else None


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

    logger.info("Pulling SF Contacts with Email + AccountId (excluding Household accounts) ...")
    # Household accounts are individual donor records (e.g. "Ohanian (Alexis) Household").
    # Mapping a firm's email domain (initialized.com) to a Household would mis-attribute
    # every employee's email to that one person — match the website-pass filter.
    res = sf.query_all(
        "SELECT Id, Email, AccountId, Account.Name, Account.Type "
        "FROM Contact "
        "WHERE Email != null AND AccountId != null "
        "AND Account.Type != 'Household'"
    )
    contacts = res.get("records", [])
    logger.info("Fetched %d SF contacts (Household-filtered)", len(contacts))

    # Group: domain -> {account_id -> count}
    by_domain: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    acct_name_lookup: dict[str, str] = {}
    household_skipped = 0
    for c in contacts:
        domain = domain_from_email(c.get("Email"))
        if not domain or domain in BLOCKLIST:
            continue
        aid = c["AccountId"]
        acct = c.get("Account") or {}
        acct_name = (acct.get("Name") or "") if isinstance(acct, dict) else ""
        acct_type = (acct.get("Type") or "") if isinstance(acct, dict) else ""
        # Belt-and-suspenders Household guard. SOQL's `Account.Type != 'Household'`
        # treats NULL as UNKNOWN, so a Household with no Type set would slip through.
        if acct_type == "Household" or "Household" in acct_name:
            household_skipped += 1
            continue
        by_domain[domain][aid] += 1
        if acct_name:
            acct_name_lookup[aid] = acct_name
    logger.info("Skipped %d Household-like contacts (defensive)", household_skipped)

    logger.info("Distinct non-blocklist domains seen across SF Contacts: %d", len(by_domain))

    conn = await asyncpg.connect(dsn)
    try:
        existing = await conn.fetch(
            "SELECT domain, sf_account_id, sf_account_name FROM bedrock.account_email_domain"
        )
        existing_map = {r["domain"]: r for r in existing}

        proposed_inserts: list[tuple[str, str, str | None, int]] = []   # (domain, aid, name, count)
        conflicts_external: list[tuple[str, str, str, str, int]] = []   # (domain, existing_aid, sf_contact_aid, name, count)
        conflicts_multi: list[tuple[str, list[tuple[str, str, int]]]] = []  # (domain, [(aid, name, count)])
        noops = 0

        for domain, aid_counts in by_domain.items():
            if len(aid_counts) > 1:
                ranked = sorted(
                    aid_counts.items(), key=lambda kv: kv[1], reverse=True
                )
                conflicts_multi.append((
                    domain,
                    [(aid, acct_name_lookup.get(aid, ""), cnt) for aid, cnt in ranked],
                ))
                continue
            aid = next(iter(aid_counts.keys()))
            count = aid_counts[aid]
            name = acct_name_lookup.get(aid)
            if domain in existing_map:
                existing_aid = existing_map[domain]["sf_account_id"]
                if existing_aid == aid:
                    noops += 1
                else:
                    conflicts_external.append((
                        domain, existing_aid, aid, name or "", count,
                    ))
                continue
            proposed_inserts.append((domain, aid, name, count))

        logger.info(
            "Summary — proposed=%d  noop=%d  conflict_external=%d  conflict_multi=%d",
            len(proposed_inserts), noops,
            len(conflicts_external), len(conflicts_multi),
        )

        # Write conflict report (always — even in apply mode)
        with open(report_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow([
                "kind", "domain", "existing_sf_account_id",
                "proposed_sf_account_id", "sf_account_name", "contact_count",
            ])
            for d, ex, pr, name, cnt in conflicts_external:
                w.writerow(["external_conflict", d, ex, pr, name, cnt])
            for d, options in conflicts_multi:
                for aid, name, cnt in options:
                    w.writerow(["multi_account_for_domain", d, "", aid, name, cnt])
        logger.info("Conflict report written to %s", report_path)

        if not apply:
            print("\n=== DRY-RUN — no inserts applied ===")
            print(f"  proposed inserts: {len(proposed_inserts)}")
            for d, aid, name, cnt in proposed_inserts[:25]:
                print(f"    {d:40s} → {aid}  ({name or '?'})  [{cnt} contacts]")
            if len(proposed_inserts) > 25:
                print(f"    ... and {len(proposed_inserts) - 25} more")
            print(f"\n  conflicts (existing row → different AccountId): {len(conflicts_external)}")
            for d, ex, pr, name, cnt in conflicts_external[:10]:
                print(f"    {d:40s} existing={ex} proposed={pr} ({name or '?'}) [{cnt} contacts]")
            if len(conflicts_external) > 10:
                print(f"    ... and {len(conflicts_external) - 10} more")
            print(f"\n  multi-account domains (SF Contacts split across multiple Accounts): {len(conflicts_multi)}")
            for d, options in conflicts_multi[:10]:
                print(f"    {d}: {[(aid[-6:], cnt) for aid, _, cnt in options]}")
            if len(conflicts_multi) > 10:
                print(f"    ... and {len(conflicts_multi) - 10} more")
            print(f"\nRun with --apply to commit the {len(proposed_inserts)} proposed inserts.\n")
            return

        # Apply
        applied = 0
        for domain, aid, name, _cnt in proposed_inserts:
            # Use 'contact_link' for source — matches the existing schema check
            # constraint and aligns with seed_account_email_domains.py's contact-pass
            # (both derive a domain from a contact, just from different sides).
            res = await conn.execute(
                """
                INSERT INTO bedrock.account_email_domain
                    (domain, sf_account_id, sf_account_name, source)
                VALUES ($1, $2, $3, 'contact_link')
                ON CONFLICT (domain) DO NOTHING
                """,
                domain, aid, name,
            )
            # Count actual inserts, not attempted; ON CONFLICT skips show as "INSERT 0 0"
            if res.endswith(" 1"):
                applied += 1
        total = await conn.fetchval(
            "SELECT count(*) FROM bedrock.account_email_domain"
        )
        logger.info(
            "APPLIED %d inserts (others skipped via ON CONFLICT). "
            "Total domain→account mappings now: %d",
            applied, total,
        )
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Commit inserts (default: dry-run)")
    ap.add_argument(
        "--report", default="/tmp/pass1_sf_contact_conflicts.csv",
        help="CSV path for conflict report (default /tmp/pass1_sf_contact_conflicts.csv)",
    )
    args = ap.parse_args()
    asyncio.run(main(args.apply, args.report))
