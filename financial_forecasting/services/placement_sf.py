"""Placement → Salesforce sync.

When a job placement is confirmed in bedrock (a builder hired into a role →
public.employment_records), mirror it into Salesforce the way fellows are
modeled there (verified against live records 2026-07-02):

  - Contact, RecordType "Pursuit Fellow"      — the builder (match by email,
    else exact name among fellow/alumni record types; create if net-new)
  - Account                                    — the employer (match by exact
    name; create if net-new)
  - npe5__Affiliation__c                       — links them, npe5__Role__c =
    role title, npe5__StartDate__c = start date, npe5__Status__c = 'Current'

Idempotent per employment_record via bedrock.placement_sf_sync. The `sf`
object needs async `query(soql)` and `create_record(sobject, data)` — both the
app's UnifiedMCPClient.salesforce and the backfill script's REST shim qualify.
"""

import logging
from typing import Any, Dict, Optional

from security import escape_soql_string

logger = logging.getLogger(__name__)

FELLOW_RECORD_TYPES = ("Pursuit Fellow", "Pursuit Core Fellow", "Pursuit Advance Fellow", "Alumni")
_fellow_rt_id: Optional[str] = None


def _rid(res) -> Optional[str]:
    if isinstance(res, dict):
        return res.get("id") or res.get("Id")
    return None


async def _fellow_record_type_id(sf) -> Optional[str]:
    global _fellow_rt_id
    if _fellow_rt_id:
        return _fellow_rt_id
    res = await sf.query(
        "SELECT Id FROM RecordType WHERE SobjectType='Contact' AND DeveloperName='Pursuit_Fellow' LIMIT 1")
    recs = res.get("records", [])
    _fellow_rt_id = recs[0]["Id"] if recs else None
    return _fellow_rt_id


class NotEligible(Exception):
    """Placement shouldn't go to Salesforce (policy, not an error)."""


def sync_eligibility(er) -> Optional[str]:
    """Return a skip-reason when a placement should NOT sync to Salesforce.

    Policy (agreed 2026-07-06): only PAID employment creates an SF
    affiliation — full-time roles, or anything with a payment amount.
    Capstones/volunteer/pro-bono work and a fellow's own venture stay out of
    the org-wide CRM (an affiliation there reads as employment). Applies the
    same regardless of whether the record is linked to a jobs deal.
    """
    if er["is_own_venture"]:
        return "own venture — not an employer relationship"
    paid = (er["payment_amount"] or 0) > 0
    if er["employment_type"] != "full_time" and not paid:
        return f"unpaid {er['employment_type'] or 'engagement'} — only paid work syncs"
    return None


async def sync_placement_to_sf(conn, sf, employment_record_id: int) -> Dict[str, Any]:
    """Ensure SF contact + account + affiliation exist for one placement.

    Raises ValueError with an actionable message when required info is
    missing (caller surfaces it to the user to fill in), and NotEligible
    when the paid-work policy excludes the record."""
    er = await conn.fetchrow(
        "SELECT id, user_id, role_title, company_name, employment_type, start_date, "
        "       payment_amount, is_own_venture "
        "FROM public.employment_records WHERE id=$1", employment_record_id)
    if not er:
        raise ValueError("Placement not found")
    skip = sync_eligibility(er)
    if skip:
        raise NotEligible(skip)
    company = (er["company_name"] or "").strip()
    if not company or company.upper() == "TBD":
        raise ValueError("This placement has no employer name — set the company before syncing to Salesforce.")
    builder = await conn.fetchrow("SELECT * FROM bedrock.builder_by_id($1)", er["user_id"])
    if not builder or not (builder["full_name"] or "").strip():
        raise ValueError("Couldn't resolve the builder for this placement — check the hire's builder.")
    b_name = builder["full_name"].strip()
    b_email = (builder["email"] or "").strip()

    out: Dict[str, Any] = {"employment_record_id": employment_record_id,
                           "created_contact": False, "created_account": False, "created_affiliation": False}

    # ── Account (exact name; SF duplicate rules guard the create) ────────────
    safe_co = escape_soql_string(company)
    res = await sf.query(f"SELECT Id, Name FROM Account WHERE Name = '{safe_co}' LIMIT 2")
    accts = res.get("records", [])
    if accts:
        sf_account_id = accts[0]["Id"]
    else:
        created = await sf.create_record("Account", {"Name": company})
        sf_account_id = _rid(created)
        if not sf_account_id:
            raise ValueError(f"Salesforce account create failed: {created}")
        out["created_account"] = True
    out["sf_account_id"] = sf_account_id

    # ── Contact (email first — fellows carry personal emails in SF — then
    #    exact name among fellow/alumni record types) ─────────────────────────
    sf_contact_id = None
    if b_email:
        res = await sf.query(
            f"SELECT Id FROM Contact WHERE Email = '{escape_soql_string(b_email)}' LIMIT 1")
        recs = res.get("records", [])
        sf_contact_id = recs[0]["Id"] if recs else None
    if not sf_contact_id:
        rt_list = ", ".join(f"'{t}'" for t in FELLOW_RECORD_TYPES)
        res = await sf.query(
            f"SELECT Id FROM Contact WHERE Name = '{escape_soql_string(b_name)}' "
            f"AND RecordType.Name IN ({rt_list}) LIMIT 2")
        recs = res.get("records", [])
        if len(recs) == 1:
            sf_contact_id = recs[0]["Id"]
    if not sf_contact_id:
        parts = b_name.split()
        first, last = (parts[0], " ".join(parts[1:])) if len(parts) > 1 else ("", parts[0])
        data = {"FirstName": first, "LastName": last}
        if b_email:
            data["Email"] = b_email
        rt = await _fellow_record_type_id(sf)
        if rt:
            data["RecordTypeId"] = rt
        created = await sf.create_record("Contact", data)
        sf_contact_id = _rid(created)
        if not sf_contact_id:
            raise ValueError(f"Salesforce contact create failed: {created}")
        out["created_contact"] = True
    out["sf_contact_id"] = sf_contact_id

    # ── Affiliation (skip if one already links this pair) ────────────────────
    res = await sf.query(
        f"SELECT Id FROM npe5__Affiliation__c WHERE npe5__Contact__c = '{sf_contact_id}' "
        f"AND npe5__Organization__c = '{sf_account_id}' LIMIT 1")
    recs = res.get("records", [])
    if recs:
        sf_affiliation_id = recs[0]["Id"]
    else:
        aff = {
            "npe5__Contact__c": sf_contact_id,
            "npe5__Organization__c": sf_account_id,
            "npe5__Status__c": "Current",
        }
        if er["role_title"] and er["role_title"].upper() != "TBD":
            aff["npe5__Role__c"] = er["role_title"]
        if er["start_date"]:
            aff["npe5__StartDate__c"] = er["start_date"].isoformat()
        created = await sf.create_record("npe5__Affiliation__c", aff)
        sf_affiliation_id = _rid(created)
        if not sf_affiliation_id:
            raise ValueError(f"Salesforce affiliation create failed: {created}")
        out["created_affiliation"] = True
    out["sf_affiliation_id"] = sf_affiliation_id

    await conn.execute(
        """INSERT INTO bedrock.placement_sf_sync
             (employment_record_id, sf_contact_id, sf_account_id, sf_affiliation_id,
              created_contact, created_account, created_affiliation, status, error, synced_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'synced',NULL,now(),now())
           ON CONFLICT (employment_record_id) DO UPDATE
             SET sf_contact_id=$2, sf_account_id=$3, sf_affiliation_id=$4,
                 created_contact=$5, created_account=$6, created_affiliation=$7,
                 status='synced', error=NULL, updated_at=now()""",
        employment_record_id, sf_contact_id, sf_account_id, sf_affiliation_id,
        out["created_contact"], out["created_account"], out["created_affiliation"])
    return out


async def record_sync_error(conn, employment_record_id: int, error: str, status: str = "error") -> None:
    """Record a non-synced outcome — status 'error' (retryable failure) or
    'skipped' (paid-work policy exclusion, shown but not retried)."""
    await conn.execute(
        """INSERT INTO bedrock.placement_sf_sync (employment_record_id, status, error, updated_at)
           VALUES ($1,$3,$2,now())
           ON CONFLICT (employment_record_id) DO UPDATE SET status=$3, error=$2, updated_at=now()""",
        employment_record_id, error[:2000], status)
