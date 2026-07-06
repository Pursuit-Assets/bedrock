"""Prospect import pipeline endpoints."""

import logging
import sys
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth
from dependencies import get_mcp_client, require_sf_mcp_client
from mcp_client import UnifiedMCPClient
from security import escape_soql_string
from sf_errors import sf_http_error
from services.cache import cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/prospect-import", tags=["prospects"])

# Ensure prospect_import package is importable
_reporoot = Path(__file__).resolve().parent.parent.parent
if str(_reporoot) not in sys.path:
    sys.path.insert(0, str(_reporoot))


class ProspectImportPreviewRequest(BaseModel):
    csv_text: str


class ProspectImportColumnMapping(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None
    organizations: Optional[List[str]] = None


class ProspectImportParseRequest(BaseModel):
    csv_text: str
    column_mapping: ProspectImportColumnMapping
    filename: str = "import.csv"


class ProspectImportWriteToCrmRequest(BaseModel):
    session_id: Optional[str] = None


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

@router.post("/preview")
async def prospect_import_preview(
    req: ProspectImportPreviewRequest,
    user=Depends(require_auth),
):
    """Parse CSV and return headers + first 20 rows for column mapping."""
    try:
        from prospect_import.parser import preview_csv

        result = preview_csv(req.csv_text, max_rows=20)
        return {"success": True, **result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

@router.post("/parse")
async def prospect_import_parse(
    req: ProspectImportParseRequest,
    user=Depends(require_auth),
):
    """Parse CSV with column mapping, normalize, and save to SQLite."""
    try:
        from prospect_import.db import (
            init_db as pi_init_db,
            create_import_session,
            save_raw_rows,
            normalize_and_save,
        )
        from prospect_import.parser import parse_csv_with_mapping

        pi_init_db()
        cm = req.column_mapping.model_dump(exclude_none=True)
        mapping = {
            "first_name": cm.get("first_name"),
            "last_name": cm.get("last_name"),
            "email": cm.get("email"),
            "organizations": cm.get("organizations") or [],
        }
        split_name_col = None
        if cm.get("name"):
            mapping["name"] = cm["name"]
            split_name_col = cm["name"]

        parsed = parse_csv_with_mapping(req.csv_text, mapping, split_name_column=split_name_col)
        session_id = create_import_session(req.filename, mapping, "")
        save_raw_rows(session_id, parsed)
        counts = normalize_and_save(session_id, parsed)
        return {"success": True, "session_id": session_id, **counts}

    except Exception as e:
        logger.exception("Error in prospect_import_parse")
        raise HTTPException(status_code=400, detail="Bad request")


# ---------------------------------------------------------------------------
# Get persons
# ---------------------------------------------------------------------------

@router.get("/persons")
async def prospect_import_get_persons(
    session_id: Optional[str] = None,
    user=Depends(require_auth),
):
    """Get normalized persons with affiliations."""
    try:
        from prospect_import.db import get_persons_with_affiliations

        persons = get_persons_with_affiliations(session_id)
        return {"success": True, "persons": persons}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Write to CRM
# ---------------------------------------------------------------------------

@router.post("/write-to-crm")
async def prospect_import_write_to_crm(
    req: ProspectImportWriteToCrmRequest,
    client: UnifiedMCPClient = Depends(require_sf_mcp_client),
    user=Depends(require_auth),
):
    """Write normalized persons and organizations to Salesforce."""
    # TODO: Phase 3 — use per-user SF tokens when available for write attribution
    try:
        from prospect_import.db import get_persons_with_affiliations

        salesforce = client.salesforce
        persons = get_persons_with_affiliations(req.session_id)
        accounts_by_name: Dict[str, str] = {}
        created_accounts = 0
        created_contacts = 0

        for p in persons:
            affs = p.get("affiliations") or []
            primary_account_id = None

            if affs:
                first_org = affs[0]
                org_name = first_org.get("org_name") or ""
                if org_name and org_name not in accounts_by_name:
                    safe_name = escape_soql_string(org_name)
                    existing = await salesforce.query(
                        f"SELECT Id FROM Account WHERE Name = '{safe_name}' AND IsDeleted = false LIMIT 1"
                    )
                    if existing.get("totalSize", 0) > 0:
                        accounts_by_name[org_name] = existing["records"][0]["Id"]
                    else:
                        acc_result = await salesforce.create_record(
                            "Account",
                            {"Name": org_name, "Type": first_org.get("org_type", "Other") or "Other"},
                        )
                        if acc_result.get("success"):
                            accounts_by_name[org_name] = acc_result["id"]
                            created_accounts += 1
                primary_account_id = accounts_by_name.get(org_name)

            contact_data = {
                "FirstName": p.get("first_name") or "Unknown",
                "LastName": p.get("last_name") or "Unknown",
            }
            if p.get("email"):
                contact_data["Email"] = p["email"]
            if primary_account_id:
                contact_data["AccountId"] = primary_account_id

            result = await salesforce.create_record("Contact", contact_data)
            if result.get("success"):
                created_contacts += 1

        cache.invalidate("accounts")
        cache.invalidate_prefix("contacts:")
        return {
            "success": True,
            "created_accounts": created_accounts,
            "created_contacts": created_contacts,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error in prospect_import_write_to_crm")
        raise sf_http_error(e, "prospect import")
