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
            res = await sf.create_record("Account", {"Name": acct_name})
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
        res = await sf.create_record("Contact", data)
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
