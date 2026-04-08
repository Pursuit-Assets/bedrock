"""SF Account ↔ public.companies matcher (Claim 4).

Walks Salesforce Accounts and tries to match each one against a row in the
platform's `public.companies` table by case-insensitive name. Writes
matches into bedrock.sf_account_company_map. Idempotent — re-running
doesn't duplicate or override existing matches because of the UNIQUE
constraint on sf_account_id and the use of ON CONFLICT DO NOTHING.

Three confidence levels in priority order:
  1. exact_name      — lower(sf_account.Name) = lower(public.companies.name)
  2. normalized_name — after stripping "The ", "Foundation", "Inc." etc.
  3. domain          — matched on email/website domain (when SF Account has Website)

Borrows the SOQL pagination + name-mapping pattern from
data_sync.py:sync_customer_mappings (lines 406-513), but writes to the
new bridge table instead of Intacct.

The matcher is read-only on public.companies (which is the only thing
bedrock_user has on public.*) and write-only on bedrock.sf_account_company_map.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Name normalization
# ---------------------------------------------------------------------------

# Suffixes to strip when computing the normalized name. Order matters:
# longer phrases must come BEFORE shorter prefixes of the same family so
# "Corporation" gets stripped before "Corp", "Limited" before "Ltd",
# "Company" before "Co". Trailing optional `\.?` is OUTSIDE the second
# `\b` so "Inc." stripping still consumes the dot but `\bcorp\b\.?` won't
# match "corp" inside "corporation".
_NAME_SUFFIX_PATTERNS = [
    r"\bcharitable\s+trust\b",
    r"\bfoundation\b",
    r"\bcorporation\b",
    r"\bcompany\b",
    r"\blimited\b",
    r"\btrust\b",
    r"\bfund\b",
    r"\binc\b\.?",
    r"\bllc\b\.?",
    r"\bllp\b\.?",
    r"\blp\b\.?",
    r"\bcorp\b\.?",
    r"\bco\b\.?",
    r"\bltd\b\.?",
    r"\bplc\b",
    r"\bgmbh\b",
    r"\bag\b",
    r"\bsa\b",
]

_LEADING_THE_PATTERN = re.compile(r"^the\s+", re.IGNORECASE)
_PUNCTUATION_PATTERN = re.compile(r"[,;.&'\"()\[\]/]")
_WHITESPACE_PATTERN = re.compile(r"\s+")


def _normalize_name(name: str) -> str:
    """Normalize a company name for fuzzy comparison.

    Strips leading "The ", trailing legal suffixes (Inc, LLC, Foundation,
    Trust, etc.), punctuation, and collapses whitespace. Result is
    lowercase, single-spaced, no leading/trailing whitespace.

    Examples:
        "The Ford Foundation"        → "ford"
        "Acme Inc."                  → "acme"
        "Robin Hood Foundation"      → "robin hood"
        "Goldman, Sachs & Co. LLC"   → "goldman sachs"
    """
    if not name:
        return ""

    s = name.lower()
    s = _LEADING_THE_PATTERN.sub("", s)
    s = _PUNCTUATION_PATTERN.sub(" ", s)
    for pattern in _NAME_SUFFIX_PATTERNS:
        s = re.sub(pattern, "", s, flags=re.IGNORECASE)
    s = _WHITESPACE_PATTERN.sub(" ", s).strip()
    return s


def _extract_domain(website: Optional[str]) -> Optional[str]:
    """Extract a normalized domain from a website URL.

    Examples:
        "https://www.fordfoundation.org/about"  → "fordfoundation.org"
        "fordfoundation.org"                    → "fordfoundation.org"
        "http://acme.com"                       → "acme.com"
        None                                    → None
    """
    if not website:
        return None
    s = website.strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = s.split("/")[0]
    s = s.split("?")[0]
    return s or None


# ---------------------------------------------------------------------------
# Single-account matcher
# ---------------------------------------------------------------------------


async def match_account(
    sf_account_id: str,
    sf_account_name: str,
    sf_account_website: Optional[str],
    db,
) -> Optional[dict]:
    """Try to match a single SF Account to a row in public.companies.

    Returns a dict like
        {"sf_account_id": ..., "public_company_id": ..., "confidence": ..., "matched_at": ...}
    if a match is found and a row was inserted, or None if no match.

    Idempotent: ON CONFLICT DO NOTHING means re-running for an
    already-matched account does nothing.
    """
    if not sf_account_name:
        return None

    # Step 1: exact lower(name) match against public.companies.
    # Uses idx_companies_name_unique (case-insensitive UNIQUE on lower(name)).
    try:
        row = await db.fetchrow(
            "SELECT company_id FROM public.companies WHERE LOWER(name) = LOWER($1) LIMIT 1",
            sf_account_name,
        )
    except Exception as e:
        logger.warning("match_account: public.companies query failed for %s: %s", sf_account_id, e)
        return None

    confidence: Optional[str] = None
    company_id: Optional[int] = None

    if row:
        company_id = row["company_id"]
        confidence = "exact_name"
    else:
        # Step 2: normalized-name match
        normalized = _normalize_name(sf_account_name)
        if normalized:
            try:
                norm_row = await db.fetchrow(
                    "SELECT company_id FROM public.companies "
                    "WHERE LOWER(REGEXP_REPLACE(name, '\\s+', ' ', 'g')) ILIKE $1 "
                    "LIMIT 1",
                    f"%{normalized}%",
                )
                if norm_row:
                    company_id = norm_row["company_id"]
                    confidence = "normalized_name"
            except Exception as e:
                logger.warning(
                    "match_account: normalized lookup failed for %s: %s", sf_account_id, e,
                )

    # Step 3: domain match (if no name match yet)
    if company_id is None:
        domain = _extract_domain(sf_account_website)
        if domain:
            try:
                dom_row = await db.fetchrow(
                    "SELECT company_id FROM public.companies WHERE LOWER(domain) = $1 LIMIT 1",
                    domain,
                )
                if dom_row:
                    company_id = dom_row["company_id"]
                    confidence = "domain"
            except Exception as e:
                logger.warning(
                    "match_account: domain lookup failed for %s: %s", sf_account_id, e,
                )

    if company_id is None or confidence is None:
        return None

    # Insert into bedrock.sf_account_company_map. ON CONFLICT preserves
    # any existing manual override.
    try:
        result_row = await db.fetchrow(
            """
            INSERT INTO bedrock.sf_account_company_map
                (sf_account_id, public_company_id, confidence, matched_by)
            VALUES ($1, $2, $3, 'auto')
            ON CONFLICT (sf_account_id) DO NOTHING
            RETURNING sf_account_id, public_company_id, confidence, matched_at
            """,
            sf_account_id, company_id, confidence,
        )
    except Exception as e:
        logger.warning("match_account: insert failed for %s: %s", sf_account_id, e)
        return None

    if result_row is None:
        # Already mapped — return the existing row for visibility
        return None

    return dict(result_row)


# ---------------------------------------------------------------------------
# Batch matcher
# ---------------------------------------------------------------------------


async def match_all_accounts(
    salesforce_client,
    db,
    limit: int = 1000,
    dry_run: bool = False,
) -> dict:
    """Walk all SF Accounts and try to match each to public.companies.

    Returns a summary like
        {"total": 499, "matched": 87, "unmatched": 412, "errors": 0,
         "by_confidence": {"exact_name": 64, "normalized_name": 18, "domain": 5}}

    If dry_run=True, no inserts are written — useful for "would this work?"
    sanity checks before committing matches.
    """
    summary = {
        "total": 0,
        "matched": 0,
        "unmatched": 0,
        "errors": 0,
        "by_confidence": {"exact_name": 0, "normalized_name": 0, "domain": 0},
    }

    try:
        accounts_query = (
            "SELECT Id, Name, Website FROM Account "
            "WHERE Name != null "
            f"ORDER BY Name LIMIT {int(limit)}"
        )
        result = await salesforce_client.query(accounts_query)
        accounts = result.get("records", [])
    except Exception as e:
        logger.error("match_all_accounts: SF query failed: %s", e)
        summary["errors"] = 1
        return summary

    summary["total"] = len(accounts)

    for account in accounts:
        sf_id = account.get("Id")
        sf_name = account.get("Name")
        sf_website = account.get("Website")

        if dry_run:
            # Just check whether a match would happen, without writing
            try:
                row = await db.fetchrow(
                    "SELECT company_id FROM public.companies WHERE LOWER(name) = LOWER($1) LIMIT 1",
                    sf_name,
                )
                if row:
                    summary["matched"] += 1
                    summary["by_confidence"]["exact_name"] += 1
                else:
                    summary["unmatched"] += 1
            except Exception as e:
                logger.warning("dry_run lookup failed for %s: %s", sf_id, e)
                summary["errors"] += 1
            continue

        try:
            match = await match_account(sf_id, sf_name, sf_website, db)
            if match:
                summary["matched"] += 1
                conf = match.get("confidence")
                if conf in summary["by_confidence"]:
                    summary["by_confidence"][conf] += 1
            else:
                summary["unmatched"] += 1
        except Exception as e:
            logger.warning("match_all_accounts: error for %s: %s", sf_id, e)
            summary["errors"] += 1

    logger.info(
        "match_all_accounts: total=%d matched=%d unmatched=%d errors=%d (dry_run=%s)",
        summary["total"], summary["matched"], summary["unmatched"], summary["errors"], dry_run,
    )
    return summary


# ---------------------------------------------------------------------------
# Listing helpers (for the admin endpoint)
# ---------------------------------------------------------------------------


async def get_unmatched_accounts(salesforce_client, db, limit: int = 500) -> list:
    """Return SF Accounts that have no row in bedrock.sf_account_company_map.

    Used by the admin review queue. The admin can manually link these or
    confirm that there's no platform-side equivalent.
    """
    try:
        sf_result = await salesforce_client.query(
            f"SELECT Id, Name, Website FROM Account WHERE Name != null ORDER BY Name LIMIT {int(limit)}"
        )
        sf_accounts = sf_result.get("records", [])
    except Exception as e:
        logger.error("get_unmatched_accounts: SF query failed: %s", e)
        return []

    matched_ids = set()
    try:
        rows = await db.fetch(
            "SELECT sf_account_id FROM bedrock.sf_account_company_map"
        )
        matched_ids = {r["sf_account_id"] for r in rows}
    except Exception as e:
        logger.warning("get_unmatched_accounts: bedrock query failed: %s", e)

    return [
        {"sf_account_id": a["Id"], "name": a["Name"], "website": a.get("Website")}
        for a in sf_accounts if a["Id"] not in matched_ids
    ]


async def list_matches(db, limit: int = 1000) -> list:
    """Return all rows from bedrock.sf_account_company_map joined with public.companies."""
    try:
        rows = await db.fetch(
            """
            SELECT m.sf_account_id, m.public_company_id, c.name AS company_name,
                   m.confidence, m.matched_by, m.matched_at, m.notes
            FROM bedrock.sf_account_company_map m
            LEFT JOIN public.companies c ON c.company_id = m.public_company_id
            ORDER BY m.matched_at DESC
            LIMIT $1
            """,
            int(limit),
        )
    except Exception as e:
        logger.warning("list_matches: cross-schema join failed (likely no public.companies on local DB): %s", e)
        # Fallback: just return the bedrock side
        rows = await db.fetch(
            "SELECT sf_account_id, public_company_id, NULL::text AS company_name, "
            "confidence, matched_by, matched_at, notes "
            "FROM bedrock.sf_account_company_map "
            "ORDER BY matched_at DESC LIMIT $1",
            int(limit),
        )
    return [dict(r) for r in rows]


async def upsert_manual_match(
    sf_account_id: str,
    public_company_id: int,
    matched_by: str,
    notes: Optional[str],
    db,
) -> dict:
    """Admin manually creates or overrides a match.

    Forces confidence='manual'. Overwrites any existing auto-match for the
    same sf_account_id.
    """
    row = await db.fetchrow(
        """
        INSERT INTO bedrock.sf_account_company_map
            (sf_account_id, public_company_id, confidence, matched_by, notes)
        VALUES ($1, $2, 'manual', $3, $4)
        ON CONFLICT (sf_account_id) DO UPDATE SET
            public_company_id = EXCLUDED.public_company_id,
            confidence        = 'manual',
            matched_by        = EXCLUDED.matched_by,
            matched_at        = now(),
            notes             = EXCLUDED.notes
        RETURNING sf_account_id, public_company_id, confidence, matched_by, matched_at, notes
        """,
        sf_account_id, public_company_id, matched_by, notes,
    )
    return dict(row)


async def delete_match(sf_account_id: str, db) -> bool:
    """Remove a match. Returns True if a row was deleted."""
    result = await db.execute(
        "DELETE FROM bedrock.sf_account_company_map WHERE sf_account_id = $1",
        sf_account_id,
    )
    return result.endswith(" 1")
