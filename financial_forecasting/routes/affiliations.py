"""Affiliations API — surfaces Salesforce Contact ↔ Account "Fellow" links.

Pursuit tracks fellow placements in Salesforce as Affiliation records. NPSP
(Nonprofit Success Pack) historically stores these on `npe5__Affiliation__c`;
some orgs use a tenant-specific `Affiliation__c`. We don't know the exact
name in this org up-front, so:

  1. The first call to any endpoint here probes the SF describe metadata and
     resolves the right SObject + role/status/start-date field names.
  2. The resolution is cached for the process lifetime. If nothing matches
     the heuristic, endpoints return an empty list with `available: false`
     so the UI can render a "Affiliation object not configured" empty state.

Endpoints:
  GET  /api/salesforce/accounts/with-fellows
       — accounts that have at least one Fellow affiliation OR at least one
         won PBC opp. Same shape as /api/salesforce/accounts.

  GET  /api/salesforce/accounts/{id}/fellows
       — affiliations on this account whose role matches /fellow/i, returned
         flat:  { contact_id, name, role, start_date, status, title, email,
                  photo_url }.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from auth import require_auth
from dependencies import require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from mcp_client.services.salesforce import _run_sf
from security import validate_salesforce_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/salesforce", tags=["affiliations"])


# ── SObject resolution ──────────────────────────────────────────────────

# Tried in priority order. Pursuit's org may use any of these — NPSP first
# since the existing Bedrock schema (e.g. npe01__OppPayment__c) shows NPSP
# is installed.
_CANDIDATE_OBJECTS = [
    "npe5__Affiliation__c",
    "Affiliation__c",
    "Fellow_Placement__c",
    "Placement__c",
    "Job__c",
]


class _AffiliationSchema:
    """Resolved field names on whichever Affiliation SObject this org uses."""

    object_name: str
    contact_field: str  # FK to Contact
    account_field: str  # FK to Account
    role_field: Optional[str]
    status_field: Optional[str]
    start_date_field: Optional[str]
    # True when we resolved via Account.childRelationships (i.e. the
    # account_field is fellow-specific by design — Pursuit's case uses
    # `Account_ForFellowsOnly__c`). In that mode, any row with the
    # account FK populated IS a fellow placement; no role filter needed.
    via_child_relationship: bool

    def __init__(
        self,
        object_name: str,
        contact_field: str,
        account_field: str,
        role_field: Optional[str],
        status_field: Optional[str],
        start_date_field: Optional[str],
        via_child_relationship: bool = False,
    ):
        self.object_name = object_name
        self.contact_field = contact_field
        self.account_field = account_field
        self.role_field = role_field
        self.status_field = status_field
        self.start_date_field = start_date_field
        self.via_child_relationship = via_child_relationship


# Module-level cache. None = not yet probed; False = probed and not found.
_SCHEMA: Optional[_AffiliationSchema] | bool = None


async def _resolve_schema(client: UnifiedMCPClient) -> Optional[_AffiliationSchema]:
    """Probe SF describe and resolve the org's Affiliation SObject + fields.

    Cached after first successful resolution. Returns None when nothing
    matches — callers should surface a tidy "not configured" message
    rather than 500.
    """
    global _SCHEMA
    if isinstance(_SCHEMA, _AffiliationSchema):
        return _SCHEMA
    if _SCHEMA is False:
        return None

    salesforce = client.salesforce
    sf_client = salesforce.sf_client  # underlying simple_salesforce instance
    if sf_client is None:
        logger.warning("affiliations: SF client not connected")
        return None

    # Preferred discovery: Account's `childRelationships` describes every
    # child SObject that has a lookup back to Account. Pursuit's custom
    # related list is `FellowsHired__r` — the relationshipName tells us
    # which SObject + which lookup field to query.
    #
    # An org can have multiple Fellow-related child relationships (Pursuit
    # has both Fellow_Applications__r and FellowsHired__r). We score the
    # candidates so we pick HIRED placements over generic applications.
    chosen: Optional[str] = None
    chosen_account_field: Optional[str] = None

    def _score(rel_name: str) -> int:
        """Higher = better. We want hired/placed, not applications."""
        n = rel_name.lower()
        if "hired" in n or "fellowshired" in n:
            return 100
        if "placement" in n or "placed" in n:
            return 80
        if "hire" in n:
            return 70
        if "fellow" in n and "applic" not in n and "candidate" not in n:
            return 50
        if "fellow" in n:
            return 20  # applications etc. — last resort
        return 0

    try:
        account_describe = await _run_sf(lambda: sf_client.Account.describe())
        candidates: list[tuple[int, str, str, str]] = []
        for child in account_describe.get("childRelationships", []):
            rel_name = child.get("relationshipName") or ""
            child_sobject = child.get("childSObject")
            field = child.get("field")
            if not child_sobject or not field or not rel_name:
                continue
            score = _score(rel_name)
            if score > 0:
                candidates.append((score, rel_name, child_sobject, field))
        candidates.sort(key=lambda t: -t[0])
        if candidates:
            logger.info(
                "affiliations: Account child relationships matching fellow/placement: %s",
                [(c[1], c[2], c[0]) for c in candidates[:5]],
            )
            _, rel_name, chosen, chosen_account_field = candidates[0]
            logger.info(
                "affiliations: chose Account.%s → %s.%s (top score)",
                rel_name, chosen, chosen_account_field,
            )
    except Exception as exc:
        logger.warning("affiliations: Account describe failed: %s", exc)

    # Fallback: global describe + name-based heuristic. Used when the
    # org doesn't have a custom FellowsHired-style child relationship.
    if chosen is None:
        try:
            global_describe = await _run_sf(lambda: sf_client.describe())
        except Exception as exc:
            logger.warning("affiliations: SF describe failed: %s", exc)
            _SCHEMA = False
            return None

        sobject_names = {s["name"] for s in global_describe.get("sobjects", [])}
        for candidate in _CANDIDATE_OBJECTS:
            if candidate in sobject_names:
                chosen = candidate
                break
        if chosen is None:
            for name in sobject_names:
                lower = name.lower()
                if any(needle in lower for needle in ("affiliation", "placement", "fellow")):
                    chosen = name
                    break

    if chosen is None:
        logger.warning("affiliations: no Affiliation-like SObject found in org")
        _SCHEMA = False
        return None

    # Pull the object's describe to find FK + role/status fields.
    try:
        obj_describe = await _run_sf(lambda: getattr(sf_client, chosen).describe())
    except Exception as exc:  # pragma: no cover
        logger.warning("affiliations: describe(%s) failed: %s", chosen, exc)
        _SCHEMA = False
        return None

    fields = obj_describe.get("fields", [])
    name_to_field: Dict[str, Dict[str, Any]] = {f["name"]: f for f in fields}

    def _find(*candidates: str) -> Optional[str]:
        for c in candidates:
            if c in name_to_field:
                return c
        # Fuzzy: any field whose name matches one of the keywords (case-insensitive).
        for f in fields:
            lower = f["name"].lower()
            for c in candidates:
                if c.lower().replace("__c", "") in lower:
                    return f["name"]
        return None

    contact_field = _find("npe5__Contact__c", "Contact__c", "ContactId", "Contact")
    # Prefer the relationship field discovered from Account.childRelationships
    # (if available); otherwise fall back to the heuristic. This matters
    # because Pursuit's custom object likely has a tenant-specific field
    # name (e.g. `Account__c`) rather than NPSP's `npe5__Organization__c`.
    account_field = chosen_account_field or _find(
        "npe5__Organization__c", "npe5__Account__c", "Account__c", "AccountId", "Account",
    )
    role_field = _find("npe5__Role__c", "Role__c", "Role")
    status_field = _find("npe5__Status__c", "Status__c", "Status")
    start_date_field = _find("npe5__StartDate__c", "Start_Date__c", "StartDate", "Hire_Date__c", "Placement_Date__c")

    if not contact_field or not account_field:
        logger.warning(
            "affiliations: resolved %s but no Contact/Account FKs found", chosen,
        )
        _SCHEMA = False
        return None

    schema = _AffiliationSchema(
        object_name=chosen,
        contact_field=contact_field,
        account_field=account_field,
        role_field=role_field,
        status_field=status_field,
        start_date_field=start_date_field,
        # True when we picked the SObject + account_field via Account's
        # childRelationships. Pursuit's `FellowsHired__r` uses a dedicated
        # `Account_ForFellowsOnly__c` field on npe5__Affiliation__c that's
        # only populated for fellow hires — so the account-FK presence is
        # the marker and no role filter is needed.
        via_child_relationship=chosen_account_field is not None,
    )
    _SCHEMA = schema
    logger.info(
        "affiliations: resolved sobject=%s contact=%s account=%s role=%s status=%s start=%s",
        schema.object_name, schema.contact_field, schema.account_field,
        schema.role_field, schema.status_field, schema.start_date_field,
    )
    return schema


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/accounts/with-fellows")
async def get_accounts_with_fellows(
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Account ids that EITHER have a Fellow affiliation OR a won PBC opp.

    Returns a thin shape — just `{ id, name, available }` — so the frontend
    can intersect with its already-cached `useAccounts()` list. We don't
    re-fetch the full account fields here because that endpoint is heavy
    and the table on the Jobs page can reuse the cached version.
    """
    schema = await _resolve_schema(client)
    salesforce = client.salesforce

    fellow_account_ids: set[str] = set()
    if schema is not None:
        # When the schema was resolved via Account.childRelationships, the
        # account_field is fellow-specific by design (Pursuit's case:
        # `Account_ForFellowsOnly__c`). Any row with that FK populated IS
        # a fellow placement — no role filter needed. For the generic
        # fallback (matched by SObject name only), narrow by role.
        clauses = [f"{schema.account_field} != NULL"]
        if not schema.via_child_relationship and schema.role_field:
            clauses.append(f"{schema.role_field} LIKE '%Fellow%'")
        soql = (
            f"SELECT {schema.account_field} FROM {schema.object_name} "
            f"WHERE {' AND '.join(clauses)}"
        )
        try:
            result = await salesforce.query(soql)
            for r in result.get("records", []):
                aid = r.get(schema.account_field)
                if aid:
                    fellow_account_ids.add(aid)
        except Exception as exc:
            logger.warning("affiliations: SOQL on %s failed: %s", schema.object_name, exc)

    # Won PBC opps — using the standard set of won stages we use elsewhere.
    won_stages = (
        "('Collecting / In Effect', 'Collecting', 'In Effect', "
        "'Closed Won', 'Closed / Completed', 'Closed / Fulfilled')"
    )
    pbc_account_ids: set[str] = set()
    try:
        pbc_result = await salesforce.query(
            f"SELECT AccountId FROM Opportunity "
            f"WHERE StageName IN {won_stages} "
            f"AND RecordType.Name = 'PBC' "
            f"AND AccountId != NULL"
        )
        for r in pbc_result.get("records", []):
            aid = r.get("AccountId")
            if aid:
                pbc_account_ids.add(aid)
    except Exception as exc:
        logger.warning("affiliations: PBC opp query failed: %s", exc)

    return {
        "fellow_account_ids": sorted(fellow_account_ids),
        "pbc_account_ids": sorted(pbc_account_ids),
        "affiliation_available": schema is not None,
    }


@router.get("/accounts/{account_id}/fellows")
async def get_fellows_for_account(
    account_id: str,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """All Fellow affiliations on this account, flattened with contact info."""
    validate_salesforce_id(account_id, "account_id")

    schema = await _resolve_schema(client)
    if schema is None:
        return {"data": [], "available": False}

    salesforce = client.salesforce
    sf_client = salesforce.sf_client

    # Build SELECT — only include fields the object actually has.
    select_fields = ["Id", schema.contact_field]
    if schema.role_field:
        select_fields.append(schema.role_field)
    if schema.status_field:
        select_fields.append(schema.status_field)
    if schema.start_date_field:
        select_fields.append(schema.start_date_field)

    where_clauses = [f"{schema.account_field} = '{account_id}'"]
    # Same rule as /with-fellows: when the schema came from Account's
    # childRelationships, the account_field is fellow-specific by design
    # and no role filter is needed. Apply role filter only for the
    # generic fallback path.
    if not schema.via_child_relationship and schema.role_field:
        where_clauses.append(f"{schema.role_field} LIKE '%Fellow%'")

    soql = (
        f"SELECT {', '.join(select_fields)} "
        f"FROM {schema.object_name} "
        f"WHERE {' AND '.join(where_clauses)}"
    )

    try:
        result = await salesforce.query(soql)
        rows = result.get("records", [])
    except Exception as exc:
        logger.warning("affiliations: fellow query failed: %s", exc)
        raise HTTPException(500, f"Failed to fetch fellows: {exc}")

    contact_ids = [r.get(schema.contact_field) for r in rows if r.get(schema.contact_field)]
    contacts_by_id: Dict[str, Dict[str, Any]] = {}
    if contact_ids:
        # Quote and join for SOQL IN clause.
        in_clause = ", ".join(f"'{cid}'" for cid in contact_ids)
        try:
            c_result = await salesforce.query(
                f"SELECT Id, Name, FirstName, LastName, Title, Email, PhotoUrl "
                f"FROM Contact WHERE Id IN ({in_clause})"
            )
            for c in c_result.get("records", []):
                contacts_by_id[c["Id"]] = c
        except Exception as exc:
            logger.warning("affiliations: contact join failed: %s", exc)

    fellows: List[Dict[str, Any]] = []
    for r in rows:
        cid = r.get(schema.contact_field)
        contact = contacts_by_id.get(cid) if cid else None
        fellows.append({
            "affiliation_id": r.get("Id"),
            "contact_id": cid,
            "name": contact.get("Name") if contact else None,
            "title": contact.get("Title") if contact else None,
            "email": contact.get("Email") if contact else None,
            "photo_url": _resolve_photo_url(contact, sf_client),
            "role": r.get(schema.role_field) if schema.role_field else None,
            "status": r.get(schema.status_field) if schema.status_field else None,
            "start_date": r.get(schema.start_date_field) if schema.start_date_field else None,
        })

    return {"data": fellows, "available": True}


def _resolve_photo_url(contact: Optional[Dict[str, Any]], sf: Any) -> Optional[str]:
    """SF Contact.PhotoUrl is a relative path; prefix with instance URL.

    Returns None when the contact has no photo or the helper can't reach
    the instance URL — the frontend falls back to initials.
    """
    if not contact:
        return None
    photo = contact.get("PhotoUrl")
    if not photo:
        return None
    base = getattr(sf, "base_url", "") or ""
    if not base:
        return photo
    # base_url ends like "/services/data/v59.0/"; strip back to scheme+host.
    try:
        host = "/".join(base.split("/")[:3])
    except Exception:
        host = ""
    return f"{host}{photo}" if photo.startswith("/") else photo
