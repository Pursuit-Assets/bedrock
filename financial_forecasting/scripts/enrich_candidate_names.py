"""Backfill display_name on bedrock.contact_candidate and account_candidate
from the names embedded in bedrock.activity.email_from headers.

Most Gmail headers come through as `Name <addr@firm.com>`. The scan layer
preserves these verbatim. This script parses them, picks the most common
name per email, and writes it to contact_candidate.display_name. It also
computes account_candidate.display_name as the most common org-style label
for that domain.

Idempotent — only writes when the column is currently NULL (so user edits
made through the UI are preserved).

Usage (from financial_forecasting/):
    python -m scripts.enrich_candidate_names              # dry-run
    python -m scripts.enrich_candidate_names --apply
"""
import argparse
import asyncio
import logging
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))
load_dotenv(override=False)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("enrich_candidate_names")

ANGLE_RE = re.compile(r"^\s*(.*?)\s*<([^>]+@[^>]+)>\s*$")


def parse_from_header(raw: str) -> tuple[str | None, str | None]:
    """`"Liliana Tai" <liliana@mckinsey.com>` → ("Liliana Tai", "liliana@mckinsey.com").
    `liliana@mckinsey.com` alone → (None, "liliana@mckinsey.com")."""
    if not raw:
        return None, None
    m = ANGLE_RE.match(raw)
    if not m:
        # bare address
        bare = raw.strip()
        return (None, bare.lower()) if "@" in bare else (None, None)
    name = m.group(1).strip().strip('"').strip("'")
    email = m.group(2).strip().lower()
    if not name or name == email:
        return None, email
    return name, email


def derive_org_name(domain: str, candidate_names: list[str]) -> str | None:
    """When a domain is uniformly used by one person, the 'name' isn't an
    org name. When many people use it, the first-word common prefix tends
    to be the org (e.g., 'McKinsey & Co' / 'McKinsey & Company' both → 'McKinsey').

    Heuristic: if 3+ distinct people share an org-prefix word, that's the
    organization. Otherwise fall back to a title-cased version of the
    domain's eTLD+1 first segment."""
    if not candidate_names:
        first = domain.split(".")[0]
        return first.capitalize() if first else None
    # Look at second-word and beyond in personal names — these are often surnames.
    # The first words are often firstnames; not useful for org name.
    # But sometimes header is `"McKinsey & Co" <noreply@mckinsey.com>` for sender
    # — treat that as an org name (no space-separated First/Last pattern).
    org_candidates = [n for n in candidate_names if " " not in n or n.lower() == n.upper()]
    if org_candidates:
        c = Counter(org_candidates)
        return c.most_common(1)[0][0]
    # Otherwise default to domain prefix
    first = domain.split(".")[0]
    return first.capitalize() if first else None


async def main(apply: bool) -> None:
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        logger.error("DATABASE_URL not set"); sys.exit(1)

    conn = await asyncpg.connect(dsn)
    try:
        # Pull every email_from we have. Limit to ones with an angle pattern.
        logger.info("Scanning bedrock.activity for parsable email_from headers...")
        rows = await conn.fetch(
            """
            SELECT email_from, activity_date
            FROM bedrock.activity
            WHERE email_from IS NOT NULL
              AND email_from <> ''
              AND email_from LIKE '%<%@%>%'
            """
        )
        logger.info("Activity rows with parsable email_from: %d", len(rows))

        # Build email → Counter(name)
        per_email: dict[str, Counter[str]] = defaultdict(Counter)
        for r in rows:
            name, email = parse_from_header(r["email_from"])
            if name and email:
                per_email[email][name] += 1

        # contact_candidate update set: email → best name
        contact_updates = {
            em: c.most_common(1)[0][0]
            for em, c in per_email.items()
        }
        logger.info("Distinct emails with extracted names: %d", len(contact_updates))

        # Build domain → all names seen at that domain (for org-name inference)
        per_domain: dict[str, list[str]] = defaultdict(list)
        for em, c in per_email.items():
            domain = em.split("@", 1)[1] if "@" in em else ""
            for name, cnt in c.items():
                per_domain[domain].extend([name] * cnt)

        # Pull candidates so we only propose updates for rows that exist
        cc_emails = {r["email"] for r in await conn.fetch(
            "SELECT email FROM bedrock.contact_candidate WHERE display_name IS NULL"
        )}
        ac_domains = {r["primary_domain"] for r in await conn.fetch(
            "SELECT primary_domain FROM bedrock.account_candidate WHERE display_name IS NULL"
        )}

        contact_writes = [(em, nm) for em, nm in contact_updates.items() if em in cc_emails]
        account_writes = []
        for d in ac_domains:
            names = per_domain.get(d, [])
            org = derive_org_name(d, names)
            if org:
                account_writes.append((d, org))

        logger.info("Pending contact_candidate updates: %d", len(contact_writes))
        logger.info("Pending account_candidate updates: %d", len(account_writes))

        if not apply:
            print("\n=== DRY-RUN ===")
            print("Top 10 sample contact updates:")
            for em, nm in contact_writes[:10]:
                print(f"  {em:50s} → {nm}")
            print("\nTop 10 sample account updates:")
            for d, nm in account_writes[:10]:
                print(f"  {d:40s} → {nm}")
            print("\nRun with --apply to commit.\n")
            return

        # Apply
        async with conn.transaction():
            for em, nm in contact_writes:
                await conn.execute(
                    "UPDATE bedrock.contact_candidate SET display_name = $2, updated_at = now() "
                    "WHERE email = $1 AND display_name IS NULL",
                    em, nm,
                )
            for d, nm in account_writes:
                await conn.execute(
                    "UPDATE bedrock.account_candidate SET display_name = $2, updated_at = now() "
                    "WHERE primary_domain = $1 AND display_name IS NULL",
                    d, nm,
                )
        cc_now = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.contact_candidate WHERE display_name IS NOT NULL"
        )
        ac_now = await conn.fetchval(
            "SELECT COUNT(*) FROM bedrock.account_candidate WHERE display_name IS NOT NULL"
        )
        logger.info("APPLIED — contact_candidate display_name set: %d", cc_now)
        logger.info("APPLIED — account_candidate display_name set: %d", ac_now)
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(args.apply))
