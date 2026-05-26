"""SF Contact → public.contacts matcher.

Walks Salesforce Contacts and resolves each to a row in public.contacts
by three signals in priority order:

  1. email        — direct email match (high confidence, unique index)
  2. linkedin_url — LinkedIn URL match (medium — URL formats may vary)
  3. name_company — full_name + account name fuzzy (low — flag for review)

Matches are written into bedrock.sf_contact_link. Idempotent: ON CONFLICT
DO NOTHING means re-running does not overwrite existing matches.

Mirrors services/sf_company_matcher.py exactly; same confidence pattern,
same admin helpers, same dry_run support.
"""

from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# LinkedIn URL normalisation
# ---------------------------------------------------------------------------

def _normalize_linkedin_url(url: Optional[str]) -> Optional[str]:
    """Strip protocol, www, trailing slash and query string.

    Examples:
        "https://www.linkedin.com/in/janedoe/"  → "linkedin.com/in/janedoe"
        "linkedin.com/in/janedoe?trk=..."       → "linkedin.com/in/janedoe"
        None                                    → None
    """
    if not url:
        return None
    s = url.strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = s.split("?")[0].rstrip("/")
    return s or None


# ---------------------------------------------------------------------------
# Single-contact matcher
# ---------------------------------------------------------------------------

async def match_contact(
    sf_contact_id: str,
    sf_email: Optional[str],
    sf_linkedin: Optional[str],
    sf_first_name: Optional[str],
    sf_last_name: Optional[str],
    sf_account_name: Optional[str],
    db,
    sf_account_id: Optional[str] = None,
) -> Optional[dict]:
    """Try to match one SF Contact to a row in public.contacts.

    Returns the inserted bedrock.sf_contact_link row as a dict, or None
    when no match was found or a match already existed.
    """
    confidence: Optional[str] = None
    contact_id: Optional[int] = None

    # 1. Email — highest confidence, unique index on public.contacts.email
    if sf_email:
        try:
            row = await db.fetchrow(
                "SELECT contact_id FROM public.contacts WHERE LOWER(email) = LOWER($1) LIMIT 1",
                sf_email,
            )
            if row:
                contact_id = row["contact_id"]
                confidence = "email"
        except Exception as e:
            logger.warning("match_contact: email lookup failed for %s: %s", sf_contact_id, e)

    # 2. LinkedIn URL — medium confidence
    if contact_id is None and sf_linkedin:
        norm = _normalize_linkedin_url(sf_linkedin)
        if norm:
            try:
                row = await db.fetchrow(
                    """
                    SELECT contact_id FROM public.contacts
                    WHERE LOWER(REGEXP_REPLACE(linkedin_url, '^https?://(www\\.)?', '', 'i'))
                        ILIKE $1
                    LIMIT 1
                    """,
                    f"%{norm.split('linkedin.com/')[-1]}%",
                )
                if row:
                    contact_id = row["contact_id"]
                    confidence = "linkedin_url"
            except Exception as e:
                logger.warning("match_contact: linkedin lookup failed for %s: %s", sf_contact_id, e)

    # 3. Name + company — low confidence (flags for human review)
    if contact_id is None and sf_first_name and sf_last_name:
        full_name = f"{sf_first_name} {sf_last_name}".strip()
        try:
            if sf_account_name:
                row = await db.fetchrow(
                    """
                    SELECT contact_id FROM public.contacts
                    WHERE LOWER(full_name) = LOWER($1)
                      AND LOWER(current_company) ILIKE $2
                    LIMIT 1
                    """,
                    full_name,
                    f"%{sf_account_name.split()[0].lower()}%",
                )
            else:
                row = await db.fetchrow(
                    "SELECT contact_id FROM public.contacts WHERE LOWER(full_name) = LOWER($1) LIMIT 1",
                    full_name,
                )
            if row:
                contact_id = row["contact_id"]
                confidence = "name_company"
        except Exception as e:
            logger.warning("match_contact: name lookup failed for %s: %s", sf_contact_id, e)

    if contact_id is None or confidence is None:
        return None

    try:
        result_row = await db.fetchrow(
            """
            INSERT INTO bedrock.sf_contact_link
                (sf_contact_id, public_contact_id, confidence, matched_by, sf_account_id)
            VALUES ($1, $2, $3, 'auto', $4)
            ON CONFLICT (sf_contact_id) DO UPDATE
                SET sf_account_id = COALESCE(EXCLUDED.sf_account_id, bedrock.sf_contact_link.sf_account_id)
            RETURNING sf_contact_id, public_contact_id, confidence, matched_at, sf_account_id
            """,
            sf_contact_id, contact_id, confidence, sf_account_id,
        )
    except Exception as e:
        logger.warning("match_contact: insert failed for %s: %s", sf_contact_id, e)
        return None

    return dict(result_row) if result_row else None


# ---------------------------------------------------------------------------
# Batch matcher
# ---------------------------------------------------------------------------

async def match_all_contacts(
    salesforce_client,
    db,
    limit: int = 2000,
    dry_run: bool = False,
) -> dict:
    """Walk SF Contacts and match each to public.contacts.

    Returns:
        {"total": n, "matched": n, "unmatched": n, "errors": n,
         "by_confidence": {"email": n, "linkedin_url": n, "name_company": n}}
    """
    summary: dict = {
        "total": 0,
        "matched": 0,
        "unmatched": 0,
        "errors": 0,
        "by_confidence": {"email": 0, "linkedin_url": 0, "name_company": 0},
    }

    # Fetch SF Contacts. LinkedIn is a custom field — skip gracefully if absent.
    # Primary_Affiliation_Name__c is the real employer; Account.Name is the NPSP
    # Household account ("Smith (Jane) Household") and is useless for matching.
    try:
        result = await salesforce_client.query_all(
            f"SELECT Id, FirstName, LastName, Email, "
            f"Primary_Affiliation_Name__c, Primary_Affiliation_Entity__c, "
            f"(SELECT Account_ForFellowsOnly__c FROM npe5__Affiliations__r WHERE npe5__Primary__c = true LIMIT 1) "
            f"FROM Contact WHERE LastName != null "
            f"ORDER BY LastName LIMIT {int(limit)}"
        )
        contacts = result.get("records", [])
    except Exception as e:
        logger.error("match_all_contacts: SF query failed: %s", e)
        summary["errors"] = 1
        return summary

    summary["total"] = len(contacts)

    for c in contacts:
        sf_id = c.get("Id")
        # Use Primary Affiliation for company name; skip Household-type affiliations
        # since those are just the person's own household, not an employer.
        affiliation_name = c.get("Primary_Affiliation_Name__c")
        entity_type = c.get("Primary_Affiliation_Entity__c") or ""
        account_name = affiliation_name if entity_type.lower() != "household" else None
        # Employer SF Account ID from the NPSP Affiliations subquery
        affiliations = c.get("npe5__Affiliations__r") or {}
        affil_records = affiliations.get("records", []) if isinstance(affiliations, dict) else []
        sf_employer_account_id = affil_records[0].get("Account_ForFellowsOnly__c") if affil_records else None

        if dry_run:
            email = (c.get("Email") or "").lower()
            if email:
                try:
                    row = await db.fetchrow(
                        "SELECT contact_id FROM public.contacts WHERE LOWER(email) = $1 LIMIT 1",
                        email,
                    )
                    if row:
                        summary["matched"] += 1
                        summary["by_confidence"]["email"] += 1
                    else:
                        summary["unmatched"] += 1
                except Exception:
                    summary["errors"] += 1
            else:
                summary["unmatched"] += 1
            continue

        try:
            match = await match_contact(
                sf_id,
                c.get("Email"),
                c.get("LinkedIn_Profile__c") or c.get("LinkedIn__c"),
                c.get("FirstName"),
                c.get("LastName"),
                account_name,
                db,
                sf_account_id=sf_employer_account_id,
            )
            if match:
                summary["matched"] += 1
                conf = match.get("confidence")
                if conf in summary["by_confidence"]:
                    summary["by_confidence"][conf] += 1
            else:
                summary["unmatched"] += 1
        except Exception as e:
            logger.warning("match_all_contacts: error for %s: %s", sf_id, e)
            summary["errors"] += 1

    logger.info(
        "match_all_contacts: total=%d matched=%d unmatched=%d errors=%d (dry_run=%s)",
        summary["total"], summary["matched"], summary["unmatched"],
        summary["errors"], dry_run,
    )
    return summary


# ---------------------------------------------------------------------------
# Admin helpers
# ---------------------------------------------------------------------------

async def get_unmatched_contacts(salesforce_client, db, limit: int = 500) -> list:
    """SF Contacts with no row in bedrock.sf_contact_link — the review queue."""
    try:
        result = await salesforce_client.query_all(
            f"SELECT Id, FirstName, LastName, Email, "
            f"Primary_Affiliation_Name__c, Primary_Affiliation_Entity__c "
            f"FROM Contact WHERE LastName != null ORDER BY LastName LIMIT {int(limit)}"
        )
        sf_contacts = result.get("records", [])
    except Exception as e:
        logger.error("get_unmatched_contacts: SF query failed: %s", e)
        return []

    matched_ids: set[str] = set()
    try:
        rows = await db.fetch("SELECT sf_contact_id FROM bedrock.sf_contact_link")
        matched_ids = {r["sf_contact_id"] for r in rows}
    except Exception as e:
        logger.warning("get_unmatched_contacts: bedrock query failed: %s", e)

    out = []
    for c in sf_contacts:
        if c["Id"] not in matched_ids:
            entity_type = c.get("Primary_Affiliation_Entity__c") or ""
            affiliation = c.get("Primary_Affiliation_Name__c")
            out.append({
                "sf_contact_id": c["Id"],
                "name": f"{c.get('FirstName', '')} {c.get('LastName', '')}".strip(),
                "email": c.get("Email"),
                "account_name": affiliation if entity_type.lower() != "household" else None,
            })
    return out


async def list_contact_matches(db, limit: int = 2000) -> list:
    """All rows in bedrock.sf_contact_link joined with public.contacts."""
    try:
        rows = await db.fetch(
            """
            SELECT l.sf_contact_id, l.public_contact_id,
                   c.full_name AS contact_name, c.email AS contact_email,
                   c.current_company,
                   l.confidence, l.matched_by, l.matched_at, l.notes
            FROM bedrock.sf_contact_link l
            LEFT JOIN public.contacts c ON c.contact_id = l.public_contact_id
            ORDER BY l.matched_at DESC
            LIMIT $1
            """,
            int(limit),
        )
    except Exception as e:
        logger.warning("list_contact_matches: join failed: %s", e)
        rows = await db.fetch(
            "SELECT sf_contact_id, public_contact_id, NULL::text AS contact_name, "
            "NULL::text AS contact_email, NULL::text AS current_company, "
            "confidence, matched_by, matched_at, notes "
            "FROM bedrock.sf_contact_link ORDER BY matched_at DESC LIMIT $1",
            int(limit),
        )
    return [dict(r) for r in rows]


async def upsert_manual_contact_match(
    sf_contact_id: str,
    public_contact_id: int,
    matched_by: str,
    notes: Optional[str],
    db,
) -> dict:
    """Admin creates or overrides a match. Forces confidence='manual'."""
    row = await db.fetchrow(
        """
        INSERT INTO bedrock.sf_contact_link
            (sf_contact_id, public_contact_id, confidence, matched_by, notes)
        VALUES ($1, $2, 'manual', $3, $4)
        ON CONFLICT (sf_contact_id) DO UPDATE SET
            public_contact_id = EXCLUDED.public_contact_id,
            confidence        = 'manual',
            matched_by        = EXCLUDED.matched_by,
            matched_at        = now(),
            notes             = EXCLUDED.notes
        RETURNING sf_contact_id, public_contact_id, confidence, matched_by, matched_at, notes
        """,
        sf_contact_id, public_contact_id, matched_by, notes,
    )
    return dict(row)


async def delete_contact_match(sf_contact_id: str, db) -> bool:
    """Remove a match. Returns True if deleted."""
    result = await db.execute(
        "DELETE FROM bedrock.sf_contact_link WHERE sf_contact_id = $1",
        sf_contact_id,
    )
    return result.endswith(" 1")
