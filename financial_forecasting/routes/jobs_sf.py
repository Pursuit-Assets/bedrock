"""Salesforce bridge for the jobs pipeline.

Contacts and accounts in the jobs module live in the local DB (public.contacts
+ the derived jobs_account view). This module lets a user "promote" a
local-only contact to Salesforce — making it ONE shared record — with three
enterprise-grade safeguards:

  1. Dedup first  — never blind-create. We search SF for likely matches
     (contact by email, then name+company; account by name) and let the user
     LINK to an existing record instead of creating a duplicate.
  2. Cascade      — a contact must hang off an SF Account. If the contact's
     company isn't in SF yet, the caller resolves the parent (link or create)
     before the contact create is allowed.
  3. Link-back    — on success we write bedrock.sf_contact_link so the record
     reads as "In Salesforce ✓" and can't be promoted twice.

Opportunities are deliberately NOT handled here: promoting an opp is a
"hand off to PBC" that creates a separate revenue Opportunity via a form
(see the opportunity handoff endpoint), not a same-record link.

  GET  /api/jobs/sf/contact/{contact_id}              — link status + promote payload
  GET  /api/jobs/sf/search-contacts?email=&name=&company=
  GET  /api/jobs/sf/search-accounts?name=
  POST /api/jobs/sf/promote-contact                   — link or create (+ account cascade)
"""

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from sf_errors import sf_http_error


async def _sf_create(sf, sobject: str, data: dict, action: str):
    """create_record that maps SF errors (duplicate/validation/session) to
    actionable HTTP statuses instead of letting them bubble to a raw 500."""
    try:
        return await sf.create_record(sobject, data)
    except Exception as e:
        raise sf_http_error(e, action)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs/sf", tags=["jobs"])


def _soql_str(s: str) -> str:
    """Escape a string literal for inlining into SOQL (single quotes + backslash)."""
    return (s or "").replace("\\", "\\\\").replace("'", "\\'")


def _records(result: Any) -> list[dict]:
    """Pull the records list out of a SOQL response (MCP or simple_salesforce)."""
    if isinstance(result, dict):
        return result.get("records") or result.get("data") or []
    return result or []


def _split_name(c: dict) -> tuple[Optional[str], Optional[str]]:
    """First/last for SF, falling back to splitting full_name when the
    structured columns are blank (many imported contacts only have full_name)."""
    first = (c.get("first_name") or "").strip()
    last = (c.get("last_name") or "").strip()
    if first and last:
        return first, last
    full = (c.get("full_name") or "").strip()
    if full:
        parts = full.split()
        if len(parts) == 1:
            return first or None, last or parts[0]
        return first or " ".join(parts[:-1]), last or parts[-1]
    return first or None, last or None


async def _contact_row(conn, contact_id: int) -> dict:
    row = await conn.fetchrow(
        """SELECT contact_id, first_name, last_name, full_name, email,
                  current_title, current_company, linkedin_url, airtable_id
           FROM public.contacts WHERE contact_id = $1""",
        contact_id,
    )
    if not row:
        raise HTTPException(404, "Contact not found")
    return dict(row)


async def _existing_link(conn, contact_id: int) -> Optional[dict]:
    row = await conn.fetchrow(
        "SELECT sf_contact_id, sf_account_id, matched_by, matched_at "
        "FROM bedrock.sf_contact_link WHERE public_contact_id = $1 "
        "ORDER BY matched_at DESC NULLS LAST LIMIT 1",
        contact_id,
    )
    return dict(row) if row else None


@router.get("/contact/{contact_id}")
async def contact_sf_status(
    contact_id: int,
    request: Request,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Is this contact already in Salesforce, and what would we send if not?

    Link status is a DB fact, so this does NOT require an SF session — the
    page must render "Local only" before the user has connected Salesforce.
    The linked SF contact's name is enriched best-effort if a session exists.
    """
    c = await _contact_row(conn, contact_id)
    link = await _existing_link(conn, contact_id)

    sf_contact = None
    if link and request.cookies.get("sf_tokens"):
        try:
            client = get_mcp_client(request)
            res = await client.salesforce.query(
                f"SELECT Id, Name, Email, AccountId, Account.Name FROM Contact "
                f"WHERE Id = '{_soql_str(link['sf_contact_id'])}' LIMIT 1"
            )
            recs = _records(res)
            if recs:
                r = recs[0]
                sf_contact = {
                    "id": r.get("Id"),
                    "name": r.get("Name"),
                    "email": r.get("Email"),
                    "account_id": r.get("AccountId"),
                    "account_name": (r.get("Account") or {}).get("Name") if r.get("Account") else None,
                }
        except Exception as e:  # link row exists but SF lookup failed — still "linked"
            logger.warning(f"SF lookup for linked contact {contact_id} failed: {e}")

    return {
        "success": True,
        "data": {
            "linked": bool(link),
            "sf_contact_id": link["sf_contact_id"] if link else None,
            "sf_account_id": link["sf_account_id"] if link else None,
            "sf_contact": sf_contact,
            # what a create would send (preview)
            "proposed": {
                "FirstName": _split_name(c)[0],
                "LastName": _split_name(c)[1],
                "Email": c["email"],
                "Title": c["current_title"],
                "LinkedIn_URL__c": c["linkedin_url"],
            },
            "company": c["current_company"],
        },
    }


@router.get("/search-contacts")
async def search_sf_contacts(
    email: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    company: Optional[str] = Query(None),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    """Dedup search: exact email first, then fuzzy name (optionally scoped to company)."""
    candidates: list[dict] = []
    seen: set = set()

    def add(recs):
        for r in recs:
            if r.get("Id") in seen:
                continue
            seen.add(r.get("Id"))
            candidates.append({
                "id": r.get("Id"),
                "name": r.get("Name"),
                "email": r.get("Email"),
                "title": r.get("Title"),
                "account_id": r.get("AccountId"),
                "account_name": (r.get("Account") or {}).get("Name") if r.get("Account") else None,
            })

    base = "SELECT Id, Name, Email, Title, AccountId, Account.Name FROM Contact WHERE "
    try:
        if email and email.strip():
            res = await client.salesforce.query(base + f"Email = '{_soql_str(email.strip())}' LIMIT 10")
            add(_records(res))
        if name and name.strip():
            clause = f"Name LIKE '%{_soql_str(name.strip())}%'"
            if company and company.strip():
                clause += f" AND Account.Name LIKE '%{_soql_str(company.strip())}%'"
            res = await client.salesforce.query(base + clause + " LIMIT 10")
            add(_records(res))
    except Exception as e:
        raise HTTPException(502, f"Salesforce search failed: {e}")

    return {"success": True, "data": {"candidates": candidates, "exact_email_match": bool(email and candidates)}}


@router.get("/search-accounts")
async def search_sf_accounts(
    name: str = Query(...),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    """Dedup search for the contact→account cascade."""
    if not name.strip():
        return {"success": True, "data": {"candidates": []}}
    try:
        res = await client.salesforce.query(
            "SELECT Id, Name, BillingCity, Type FROM Account "
            f"WHERE Name LIKE '%{_soql_str(name.strip())}%' ORDER BY Name LIMIT 10"
        )
    except Exception as e:
        raise HTTPException(502, f"Salesforce search failed: {e}")
    cands = [{
        "id": r.get("Id"), "name": r.get("Name"),
        "city": r.get("BillingCity"), "type": r.get("Type"),
    } for r in _records(res)]
    return {"success": True, "data": {"candidates": cands}}


class AccountResolve(BaseModel):
    mode: str                     # "link" | "create" | "none"
    sf_account_id: Optional[str] = None
    name: Optional[str] = None


class PromoteContact(BaseModel):
    contact_id: int
    mode: str                     # "link" | "create"
    sf_contact_id: Optional[str] = None      # required when mode == "link"
    account: Optional[AccountResolve] = None
    # explicit field overrides for the create (from the on-screen preview)
    fields: Optional[dict] = None


def _result_id(res: Any) -> Optional[str]:
    if isinstance(res, dict):
        return res.get("id") or res.get("Id")
    return None


@router.post("/promote-contact")
async def promote_contact(
    body: PromoteContact,
    user=Depends(require_auth),
    conn=Depends(get_db),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    """Link an existing SF contact, or create a new one (resolving its account
    first), then write the local→SF link so it reads as one record."""
    c = await _contact_row(conn, body.contact_id)
    if await _existing_link(conn, body.contact_id):
        raise HTTPException(409, "Contact is already linked to Salesforce")

    sf = client.salesforce

    # 1) resolve the account (cascade)
    sf_account_id: Optional[str] = None
    acct = body.account
    if acct:
        if acct.mode == "link":
            if not acct.sf_account_id:
                raise HTTPException(400, "account.sf_account_id required to link")
            sf_account_id = acct.sf_account_id
        elif acct.mode == "create":
            acct_name = (acct.name or c["current_company"] or "").strip()
            if not acct_name:
                raise HTTPException(400, "account name required to create an account")
            res = await _sf_create(sf, "Account", {"Name": acct_name}, "account")
            sf_account_id = _result_id(res)
            if not sf_account_id:
                raise HTTPException(502, f"Failed to create Salesforce account: {res}")

    # 2) resolve the contact
    if body.mode == "link":
        if not body.sf_contact_id:
            raise HTTPException(400, "sf_contact_id required to link")
        sf_contact_id = body.sf_contact_id
        if not sf_account_id:
            # adopt the existing contact's account for the link record
            try:
                recs = _records(await sf.query(
                    f"SELECT AccountId FROM Contact WHERE Id = '{_soql_str(sf_contact_id)}' LIMIT 1"))
                if recs:
                    sf_account_id = recs[0].get("AccountId")
            except Exception:
                pass
    elif body.mode == "create":
        first, last = _split_name(c)
        if not last:
            raise HTTPException(400, "Contact needs a last name to create in Salesforce")
        data: dict = {
            "FirstName": first,
            "LastName": last,
            "Email": c["email"],
            "Title": c["current_title"],
            "LinkedIn_URL__c": c["linkedin_url"],
        }
        if sf_account_id:
            data["AccountId"] = sf_account_id
        if body.fields:                      # preview overrides
            data.update({k: v for k, v in body.fields.items() if v is not None})
        data = {k: v for k, v in data.items() if v not in (None, "")}
        res = await _sf_create(sf, "Contact", data, "contact")
        sf_contact_id = _result_id(res)
        if not sf_contact_id:
            raise HTTPException(502, f"Failed to create Salesforce contact: {res}")
    else:
        raise HTTPException(400, f"Invalid mode: {body.mode}")

    # 3) link-back
    async with conn.transaction():
        await conn.execute(
            "DELETE FROM bedrock.sf_contact_link WHERE public_contact_id = $1", body.contact_id)
        await conn.execute(
            """INSERT INTO bedrock.sf_contact_link
                   (sf_contact_id, public_contact_id, sf_account_id, confidence, matched_by, matched_at)
               VALUES ($1, $2, $3, 'manual', $4, now())""",
            sf_contact_id, body.contact_id, sf_account_id,
            (user.get("email") if isinstance(user, dict) else None) or "manual",
        )

    return {"success": True, "data": {
        "sf_contact_id": sf_contact_id,
        "sf_account_id": sf_account_id,
        "linked": True,
    }}


class HandoffOpportunity(BaseModel):
    opp_id: str
    name: str
    stage: str = "New Lead"
    amount: Optional[float] = None
    close_date: str                          # YYYY-MM-DD (SF requires CloseDate)
    primary_contact_sf_id: Optional[str] = None
    # account resolution (the SF opp needs an AccountId)
    account_sf_id: Optional[str] = None       # link an existing SF account
    account_create_name: Optional[str] = None # or create one with this name


@router.post("/handoff-opportunity")
async def handoff_opportunity(
    body: HandoffOpportunity,
    user=Depends(require_auth),
    conn=Depends(get_db),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    """Hand a jobs opportunity off to PBC: create a SEPARATE revenue
    Opportunity in Salesforce (RecordType = PBC) and link it back to the jobs
    opp via sf_opportunity_id. This is a handoff, not a same-record merge — the
    jobs opp keeps its own hiring pipeline."""
    opp = await conn.fetchrow(
        "SELECT id, account_name, sf_opportunity_id FROM bedrock.jobs_opportunity "
        "WHERE id = $1 AND deleted_at IS NULL",
        body.opp_id,
    )
    if not opp:
        raise HTTPException(404, "Opportunity not found")
    if opp["sf_opportunity_id"]:
        raise HTTPException(409, "Opportunity has already been handed off to Salesforce")
    if not body.name.strip():
        raise HTTPException(400, "name is required")

    sf = client.salesforce

    # resolve account
    account_id = body.account_sf_id
    if not account_id and body.account_create_name:
        res = await _sf_create(sf, "Account", {"Name": body.account_create_name.strip()}, "account")
        account_id = _result_id(res)
        if not account_id:
            raise HTTPException(502, f"Failed to create Salesforce account: {res}")
    if not account_id:
        raise HTTPException(400, "An account (link or create) is required for a Salesforce opportunity")

    # look up the PBC record type at runtime (no hardcoded id)
    record_type_id: Optional[str] = None
    try:
        recs = _records(await sf.query(
            "SELECT Id FROM RecordType WHERE SobjectType = 'Opportunity' "
            "AND Name = 'PBC' AND IsActive = true LIMIT 1"))
        if recs:
            record_type_id = recs[0].get("Id")
    except Exception as e:
        logger.warning(f"PBC record type lookup failed: {e}")
    if not record_type_id:
        raise HTTPException(502, "Couldn't find an active 'PBC' Opportunity record type in Salesforce")

    data: dict = {
        "Name": body.name.strip(),
        "AccountId": account_id,
        "StageName": body.stage,
        "CloseDate": body.close_date,
        "RecordTypeId": record_type_id,
    }
    if body.amount is not None:
        data["Amount"] = body.amount
    if body.primary_contact_sf_id:
        data["npsp__Primary_Contact__c"] = body.primary_contact_sf_id

    res = await _sf_create(sf, "Opportunity", data, "opportunity")
    sf_opp_id = _result_id(res)
    if not sf_opp_id:
        raise HTTPException(502, f"Failed to create Salesforce opportunity: {res}")

    await conn.execute(
        "UPDATE bedrock.jobs_opportunity SET sf_opportunity_id = $1 WHERE id = $2",
        sf_opp_id, body.opp_id,
    )
    return {"success": True, "data": {"sf_opportunity_id": sf_opp_id, "account_id": account_id}}


class PromoteAccount(BaseModel):
    account_key: str
    display_name: str
    mode: str                     # "link" | "create"
    sf_account_id: Optional[str] = None


@router.post("/promote-account")
async def promote_account(
    body: PromoteAccount,
    user=Depends(require_auth),
    conn=Depends(get_db),
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
):
    """Link an existing SF account, or create a new one, then persist the link
    on bedrock.jobs_account so the account reads as 'In Salesforce'."""
    if body.mode == "link":
        if not body.sf_account_id:
            raise HTTPException(400, "sf_account_id required to link")
        sf_account_id = body.sf_account_id
    elif body.mode == "create":
        name = (body.display_name or "").strip()
        if not name:
            raise HTTPException(400, "Account needs a name to create in Salesforce")
        res = await _sf_create(client.salesforce, "Account", {"Name": name}, "account")
        sf_account_id = _result_id(res)
        if not sf_account_id:
            raise HTTPException(502, f"Failed to create Salesforce account: {res}")
    else:
        raise HTTPException(400, f"Invalid mode: {body.mode}")

    # Persist the link on the override row (upsert by account_key).
    await conn.execute(
        """INSERT INTO bedrock.jobs_account (account_key, display_name, sf_account_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_key) DO UPDATE
             SET sf_account_id = EXCLUDED.sf_account_id, updated_at = now()""",
        body.account_key, body.display_name, sf_account_id,
    )
    return {"success": True, "data": {"sf_account_id": sf_account_id, "linked": True}}
