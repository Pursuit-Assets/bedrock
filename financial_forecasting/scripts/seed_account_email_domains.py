"""Populate bedrock.account_email_domain from SF Account websites.

Pulls all SF Accounts with a Website field, normalizes the domain
(strips protocol/www/path), and upserts into bedrock.account_email_domain.

Also seeds from contacts already linked to accounts (sf_contact_link).

Safe to re-run (ON CONFLICT DO UPDATE).

Usage (from financial_forecasting/):
    python -m scripts.seed_account_email_domains
"""

import asyncio
import logging
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import asyncpg
from dotenv import load_dotenv
from simple_salesforce import Salesforce

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Free email providers — never link by domain for these
BLOCKLIST = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "aol.com", "mail.com", "live.com", "msn.com", "googlemail.com",
    "protonmail.com", "me.com", "mac.com", "pursuit.org", "pursuitnyc.org",
}


def normalize_domain(raw: str) -> str | None:
    """Extract clean domain from a website URL or bare domain string."""
    if not raw:
        return None
    raw = raw.strip().lower()
    # Add scheme if missing so urlparse works
    if not raw.startswith(("http://", "https://")):
        raw = "https://" + raw
    try:
        parsed = urlparse(raw)
        host = parsed.hostname or ""
        # Strip www.
        host = re.sub(r"^www\.", "", host)
        return host if "." in host else None
    except Exception:
        return None


async def main():
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    conn = await asyncpg.connect(dsn)

    # Apply migration if table doesn't exist
    migration = (
        Path(__file__).parent.parent
        / "db" / "migrations"
        / "2026-05-25-add-account-email-domain.sql"
    )
    await conn.execute(migration.read_text())
    logger.info("Migration applied")

    sf = Salesforce(
        username=os.getenv("SALESFORCE_USERNAME"),
        password=os.getenv("SALESFORCE_PASSWORD"),
        security_token=os.getenv("SALESFORCE_SECURITY_TOKEN", ""),
        domain=os.getenv("SALESFORCE_DOMAIN", "login"),
    )

    # --- Source 1: SF Account websites ---
    logger.info("Fetching SF accounts with websites...")
    result = sf.query_all(
        "SELECT Id, Name, Website FROM Account "
        "WHERE Website != null AND Type != 'Household'"
    )
    accounts = result.get("records", [])
    logger.info("Fetched %d SF accounts", len(accounts))

    sf_website_count = 0
    for acct in accounts:
        domain = normalize_domain(acct.get("Website", ""))
        if not domain or domain in BLOCKLIST:
            continue
        await conn.execute(
            """
            INSERT INTO bedrock.account_email_domain
                (domain, sf_account_id, sf_account_name, source)
            VALUES ($1, $2, $3, 'sf_website')
            ON CONFLICT (domain) DO UPDATE SET
                sf_account_id   = EXCLUDED.sf_account_id,
                sf_account_name = EXCLUDED.sf_account_name,
                source          = 'sf_website'
            """,
            domain,
            acct["Id"],
            acct.get("Name"),
        )
        sf_website_count += 1

    logger.info("Upserted %d domain→account rows from SF websites", sf_website_count)

    # --- Source 2: contacts already linked to accounts ---
    logger.info("Seeding from contact email domains...")
    rows = await conn.fetch(
        """
        SELECT DISTINCT
            lower(split_part(c.email, '@', 2)) AS domain,
            scl.sf_account_id
        FROM public.contacts c
        JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE scl.sf_account_id IS NOT NULL
          AND c.email LIKE '%@%'
        """
    )

    contact_domain_count = 0
    for row in rows:
        domain = row["domain"]
        if not domain or domain in BLOCKLIST or "." not in domain:
            continue
        # Don't overwrite a higher-confidence sf_website entry
        await conn.execute(
            """
            INSERT INTO bedrock.account_email_domain
                (domain, sf_account_id, source)
            VALUES ($1, $2, 'contact_link')
            ON CONFLICT (domain) DO NOTHING
            """,
            domain,
            row["sf_account_id"],
        )
        contact_domain_count += 1

    logger.info("Added %d domain→account rows from contact emails", contact_domain_count)

    total = await conn.fetchval("SELECT count(*) FROM bedrock.account_email_domain")
    print(f"\nDone. Total domain→account mappings: {total}")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
