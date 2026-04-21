"""FastAPI backend for financial forecasting system."""

import os
import asyncio
from dotenv import load_dotenv
load_dotenv(override=False)
from typing import Any, Dict, List, Optional
from datetime import datetime, date, timedelta
from decimal import Decimal
from difflib import SequenceMatcher
import logging

from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from pydantic import BaseModel, validator
import uvicorn

# Import our MCP client and models
import sys
# Prefer financial_forecasting/mcp_client (has Calendar, Gmail, Fireflies services)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp_client import UnifiedMCPClient
from models import (
    SalesforceOpportunity, SalesforceAccount, IntacctInvoice, IntacctPayment,
    PaymentForecast, CashFlowProjection, ForecastingMetrics, ForecastingReport,
    OpportunityUpdateRequest, InvoiceCreationRequest, ForecastingDashboardData,
    OpportunityStage, PaymentTerms, InvoiceStatus,
    OPEN_STAGES, CLOSED_STAGES, COLLECTING_STAGES,
    WON_STAGES_SET, LOST_STAGES_SET,
    ApiResponse,
)
from forecasting_engine import ForecastingEngine
from data_sync import DataSyncService
from db import init_db, close_db, get_db, get_db_status
from routes.projects import router as projects_router
from routes.auth import router as auth_router, get_google_credentials, PBD_CALENDAR_ID
from routes.sf_dependencies import router as sf_deps_router
from routes.permissions import router as permissions_router, opp_router as opp_lock_router, check_permission, check_permission_or_internal, resolve_task_lock
from routes.opportunities_extra import router as opp_extra_router
from routes.owner_goals import router as owner_goals_router
from routes.payment_schedules import router as payment_schedules_router
from routes.finance import router as finance_router
from routes.sage import router as sage_router
from routes.prospects import router as prospects_router
from routes.activity_intelligence import router as activity_intel_router
from routes.slack_routes import router as slack_router
from routes.ai import router as ai_router
from routes.salesforce_search import router as sf_search_router
from routes.salesforce_schema import router as sf_schema_router
from routes.admin_sf_drift import router as admin_sf_drift_router
from routes.admin_company_match import router as admin_company_match_router
from routes.activities import router as activities_router
from auth import get_current_user_dep, require_auth, IS_PRODUCTION, JWT_SECRET_KEY
from security import validate_salesforce_id, escape_soql_string
from services.crm_parser import refresh_opp_cache as _refresh_opp_cache
from services.cache import cache, CACHE_TTL_OPPORTUNITIES, CACHE_TTL_ACCOUNTS, CACHE_TTL_USERS, CACHE_TTL_CASHFLOW

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Production detection (duplicated here for app init; also in auth.py)
_IS_PROD = os.getenv('FRONTEND_URL', '').startswith('https')

# Initialize FastAPI app
app = FastAPI(
    title="Financial Forecasting API",
    description="API for sales pipeline and financial forecasting integration",
    version="1.0.0",
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None if _IS_PROD else "/redoc",
)

limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Session middleware (required for Authlib OAuth state)
app.add_middleware(
    SessionMiddleware,
    secret_key=JWT_SECRET_KEY,
    session_cookie="session",
    max_age=3600 * 24,
    same_site="none" if IS_PRODUCTION else "lax",
    https_only=IS_PRODUCTION,
)

# CORS middleware
CORS_ORIGINS = ["http://localhost:3000", "http://localhost:3001", "http://localhost:4000"]
FRONTEND_URL = os.getenv('FRONTEND_URL')
if FRONTEND_URL:
    CORS_ORIGINS.append(FRONTEND_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Api-Key", "X-Internal-Key", "Cookie"],
)

# Routers
app.include_router(projects_router)
app.include_router(auth_router)
app.include_router(sf_deps_router)
app.include_router(permissions_router)
app.include_router(opp_lock_router)
# Phase 2 route files
app.include_router(opp_extra_router)
app.include_router(owner_goals_router)
app.include_router(payment_schedules_router)
app.include_router(finance_router)
app.include_router(sage_router)
app.include_router(prospects_router)
app.include_router(activity_intel_router)
app.include_router(slack_router)
app.include_router(ai_router)
app.include_router(sf_search_router)
app.include_router(sf_schema_router)
app.include_router(admin_sf_drift_router)
app.include_router(admin_company_match_router)
app.include_router(activities_router)

# Service singletons — shared with dependencies.py so route files can use
# Depends(get_mcp_client) without circular imports.
import dependencies as _deps
_services = _deps._services
from dependencies import _sync_lock, get_data_sync_service

# Startup and shutdown events

@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    logger.info("=" * 60)
    logger.info("  BEDROCK API — main.py (production server)")
    logger.info("  simple_server.py is DEPRECATED — do not use")
    logger.info("=" * 60)

    # Validate required environment variables FIRST.
    # In production this raises and aborts startup.
    # In development it logs warnings and continues.
    from env_validator import validate_required_env, current_environment
    validate_required_env(current_environment())

    # Initialize PostgreSQL (non-blocking — app works without it)
    await init_db()

    client = UnifiedMCPClient()
    _services["mcp_client"] = client

    # Connect all services gracefully — each is independent
    for svc_name, connect_fn in [
        ("Salesforce", lambda: client.connect_salesforce(None)),
        ("Sage Intacct", lambda: client.connect_sage_intacct(None)),
        ("Slack", lambda: client.connect_slack(None)),
        ("Google Calendar", lambda: client.connect_google_calendar()),
        ("Gmail", lambda: client.connect_gmail()),
        ("Fireflies", lambda: client.connect_fireflies()),
    ]:
        try:
            await connect_fn()
            logger.info(f"{svc_name} connected successfully")
        except Exception as e:
            logger.warning(f"{svc_name} not available: {e}")

    # Set up dependent services if Salesforce connected
    if "salesforce" in client.connected_services:
        _services["forecasting_engine"] = ForecastingEngine(client)
        # Pass db_pool for activity sync; fall back to no-DB if pool unavailable
        try:
            from db import get_pool
            _services["data_sync_service"] = DataSyncService(client, db_pool=get_pool())
        except Exception:
            _services["data_sync_service"] = DataSyncService(client)
        asyncio.create_task(background_sync_task())

    logger.info(f"API started — connected services: {client.connected_services or ['none']}")


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown."""
    logger.info("Shutting down Financial Forecasting API...")
    await close_db()
    client = _services.get("mcp_client")
    if client:
        await client.disconnect_all()
    logger.info("Shutdown complete.")


# Background tasks

async def background_sync_task():
    """Background task to sync data periodically."""
    while True:
        try:
            data_sync_service = _services.get("data_sync_service")
            if data_sync_service:
                        # Non-blocking acquire — skip cycle if lock held
                if _sync_lock.locked():
                    logger.warning("Sync already in progress, skipping cycle.")
                else:
                    async with _sync_lock:
                        logger.info("Running background data sync...")
                        await data_sync_service.sync_all_data()
                        logger.info("Background data sync completed.")
        except Exception as e:
            logger.error(f"Background sync error: {e}")

        # Wait 15 minutes before next sync
        await asyncio.sleep(900)


# Dependency functions — get_current_user is now cookie-based (see auth.py)
get_current_user = get_current_user_dep


def get_mcp_client(request: Request = None) -> UnifiedMCPClient:
    """Get MCP client dependency — delegates to dependencies.py."""
    from dependencies import get_mcp_client as _get
    return _get(request)


def get_forecasting_engine() -> ForecastingEngine:
    """Get forecasting engine dependency."""
    engine = _services.get("forecasting_engine")
    if not engine:
        raise HTTPException(status_code=503, detail="Forecasting engine not initialized")
    return engine


# get_data_sync_service() moved to dependencies.py

# Cashflow summary moved to routes/finance.py

# Health check endpoints

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    db_status = get_db_status()
    db_healthy = db_status == "connected"
    return ApiResponse(
        success=db_healthy,
        data={"status": "healthy" if db_healthy else "degraded"},
        meta={
            "timestamp": datetime.utcnow().isoformat(),
            "services": {
                "database": db_status,
                "mcp_client": "mcp_client" in _services,
                "forecasting_engine": "forecasting_engine" in _services,
                "data_sync_service": "data_sync_service" in _services,
            },
        },
    )


@app.get("/health/services")
async def services_health_check(
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Check health of connected services."""
    health_status = {}

    for service_name in client._connected_services:
        try:
            service = client.services[service_name]
            info = await service.get_service_info()
            health_status[service_name] = {
                "status": "healthy" if info["authenticated"] else "unhealthy",
                "authenticated": info["authenticated"],
                "config": info.get("config", {})
            }
        except Exception as e:
            health_status[service_name] = {
                "status": "error",
                "error": str(e)
            }

    return ApiResponse(success=True, data=health_status)


# Salesforce endpoints

# Valid stages admit the 13-stage OpportunityStage enum values PLUS the F1 bucket-set
# members that live outside the enum (notably "Closed Won", the Donorbox-auto-populated
# philanthropy stage). Callers passing stages=['Closed Won'] were silently dropped before
# this widened — see tasks/stage-schema-drift.md § "Known pre-existing defects" item 3.
VALID_STAGES = {s.value for s in OpportunityStage} | WON_STAGES_SET | LOST_STAGES_SET


@app.get("/api/salesforce/opportunities")
async def get_opportunities(
    stage: Optional[OpportunityStage] = None,
    stages: Optional[List[str]] = Query(None),
    limit: Optional[int] = Query(None, le=2000),
    record_type: Optional[str] = Query(None, description="Filter by RecordType.Name (e.g. 'Philanthropy')"),
    active_only: bool = Query(False, description="Only return Active_Opportunity__c = true"),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce opportunities with optional server-side filtering."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        # Server-side cache — key encodes all filter params
        stage_val = stage.value if stage else None
        stages_key = ",".join(sorted(stages)) if stages else None
        cache_key = f"opps:{stage_val}:{stages_key}:{record_type}:{active_only}:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        # Build SOQL query — field list matches proven simple_server.py query
        query = """
        SELECT Id, AccountId, Account.Name, Name, StageName, Amount, Probability,
               CloseDate, ForecastCategory, LeadSource, NextStep,
               Description, OwnerId, Owner.Name, CreatedDate, LastModifiedDate,
               npe01__Payments_Made__c, Outstanding_Payments__c,
               Number_of_Payments_Received__c, Most_Recent_Payment_Date__c,
               Last_Actual_Payment__c, npe01__Number_of_Payments__c,
               PaymentDate__c, Earliest_Scheduled_Payment__c,
               RenewalRepeat__c,
               Contract_Start_Date__c, Contract_End_Date__c,
               Payment_Terms__c, Billing_Frequency__c,
               RecordTypeId, RecordType.Name, Active_Opportunity__c
        FROM Opportunity
        """

        where_clauses = []
        if stage:
            where_clauses.append(f"StageName = '{stage.value}'")
        if stages:
            validated = [s for s in stages if s in VALID_STAGES]
            if validated:
                stage_list = ", ".join(f"'{s}'" for s in validated)
                where_clauses.append(f"StageName IN ({stage_list})")
        if record_type:
            where_clauses.append(f"RecordType.Name = '{escape_soql_string(record_type)}'")
        if active_only:
            where_clauses.append("Active_Opportunity__c = true")
        if where_clauses:
            query += " WHERE " + " AND ".join(where_clauses)

        query += " ORDER BY CloseDate DESC"
        if limit is not None:
            query += f" LIMIT {limit}"

        # Use query_all for automatic pagination
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Cache the result and refresh entity cache for Slack parser
        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        _refresh_opp_cache(records)

        return records

    except Exception as e:
        logger.error(f"Error fetching opportunities: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/salesforce/opportunities")
async def create_opportunity(
    opp_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("create_opportunities")),
):
    """Create a new Salesforce opportunity."""
    try:
        salesforce = client.salesforce
        result = await salesforce.create_record("Opportunity", opp_data)
        if result and (result.get("id") or result.get("Id")):
            new_id = result.get("id") or result.get("Id")
            cache.invalidate_prefix("opps:")
            logger.info(f"Opportunity created: {new_id} by {user.get('email', 'unknown')}")
            return ApiResponse(success=True, data={"id": new_id, "message": "Opportunity created"})
        raise HTTPException(400, "Failed to create opportunity — no ID returned")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating opportunity: {e}")
        raise HTTPException(500, str(e))


@app.put("/api/salesforce/opportunities/{opportunity_id}")
async def update_opportunity(
    opportunity_id: str,
    update_request: OpportunityUpdateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("edit_own_opportunities")),
    db = Depends(get_db),
):
    """Update a Salesforce opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        # Extract permission context (shared by lock, ownership, and reassignment checks)
        perms = user.get("_permissions", {})
        sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
        is_admin = perms.get("manage_users_roles", False)
        has_edit_all = perms.get("edit_all_opportunities", False)
        salesforce = client.salesforce

        # Enforce opportunity lock — only owner or admin can edit locked opportunities
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
        )
        if lock:
            is_lock_owner = (lock["locked_by"] == sf_user_id)
            if not is_lock_owner and not is_admin:
                raise HTTPException(status_code=403, detail="This opportunity is locked by its owner")

        # Ownership enforcement — edit_own vs edit_all
        if not is_admin and not has_edit_all:
            # User only has edit_own — verify they own this opportunity
            if sf_user_id:
                current_opp = await salesforce.query(
                    f"SELECT OwnerId FROM Opportunity WHERE Id = '{opportunity_id}' LIMIT 1"
                )
                records = current_opp.get("records", [])
                if records:
                    current_owner = records[0].get("OwnerId")
                    if current_owner != sf_user_id:
                        raise HTTPException(status_code=403, detail="You can only edit opportunities you own")

        # OwnerId reassignment requires reassign_opportunities permission
        if "OwnerId" in update_request.updates:
            if not is_admin:
                if not perms.get("reassign_opportunities", False):
                    raise HTTPException(status_code=403, detail="You don't have permission to reassign opportunities")

        success = await salesforce.update_record(
            "Opportunity",
            opportunity_id,
            update_request.updates
        )

        if success:
            cache.invalidate_prefix("opps:")
            cache.invalidate("stage_history:30")
            logger.info(f"Opportunity {opportunity_id} updated by {user['user_id']}")
            return ApiResponse(success=True, data={"id": opportunity_id, "message": "Opportunity updated successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to update opportunity")

    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error updating opportunity {opportunity_id}: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)


@app.get("/api/salesforce/accounts")
async def get_accounts(
    # `le=2000` matches GET /api/salesforce/opportunities — defensive upper
    # bound for callers that want a capped response. Default `None` means
    # "return all" via query_all() pagination; the frontend relies on this
    # to avoid silent truncation when Pursuit's Account count exceeds 2000.
    limit: Optional[int] = Query(None, le=2000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce accounts."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        cache_key = f"accounts:{limit or 'all'}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        query = """
        SELECT Id, Name, Type, Industry, Phone, Fax, Website, Description,
               BillingStreet, BillingCity, BillingState, BillingPostalCode, BillingCountry,
               AnnualRevenue, NumberOfEmployees, AccountSource, OwnerId, Owner.Name,
               ParentId, RecordTypeId, RecordType.Name,
               CreatedDate, LastModifiedDate, LastActivityDate,
               Account_Tier__c, Active__c, Company_Size__c,
               npsp__Grantmaker__c, npsp__Funding_Focus__c,
               Philanthropy__c, Fee_For_Service__c, Hiring__c, Investment__c,
               Volunteering__c, Fellow_Recruitment__c, Media_Marketing__c,
               Influence__c, Startup__c, Organization_Focus_Area_s__c,
               npo02__TotalOppAmount__c, npo02__NumberOfClosedOpps__c,
               npo02__AverageAmount__c, npo02__LargestAmount__c, npo02__SmallestAmount__c,
               npo02__FirstCloseDate__c, npo02__LastCloseDate__c,
               npo02__OppAmountThisYear__c, npo02__OppAmountLastYear__c,
               npo02__Best_Gift_Year__c, npo02__Best_Gift_Year_Total__c,
               npsp__Matching_Gift_Company__c, npsp__Matching_Gift_Percent__c,
               npsp__Matching_Gift_Amount_Max__c, npsp__Matching_Gift_Amount_Min__c,
               npsp__Matching_Gift_Annual_Employee_Max__c,
               npsp__Matching_Gift_Administrator_Name__c, npsp__Matching_Gift_Email__c,
               npsp__Matching_Gift_Phone__c, npsp__Matching_Gift_Comments__c,
               npsp__Matching_Gift_Info_Updated__c, npsp__Matching_Gift_Request_Deadline__c,
               Total_Revenue_Generated__c,
               Last_Activity_Date__c, Date_of_First_Pursuit_Hire__c
        FROM Account
        ORDER BY Name ASC
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        records = result.get("records", [])
        cache.set(cache_key, records, CACHE_TTL_ACCOUNTS)
        return records

    except Exception as e:
        logger.error(f"Error fetching accounts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/salesforce/accounts")
async def create_account(
    account_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("create_accounts"))
):
    """Create a new Salesforce account."""
    try:
        salesforce = client.salesforce

        # Create the account
        result = await salesforce.create_record("Account", account_data)

        if result and result.get("id"):
            cache.invalidate_prefix("accounts:")
            logger.info(f"Account created with ID: {result['id']} by {user['user_id']}")
            return ApiResponse(success=True, data={"id": result["id"], "message": "Account created successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to create account")
            
    except Exception as e:
        logger.error(f"Error creating account: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/salesforce/contacts")
async def get_contacts(
    account_id: Optional[str] = None,
    # `le=5000` retained from prior behavior (contacts cap was deliberately
    # looser than accounts). Default `None` means "return all" via query_all
    # pagination; the frontend relies on this to avoid silent truncation.
    limit: Optional[int] = Query(None, le=5000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce contacts, optionally filtered by account."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        cache_key = f"contacts:{account_id}:{limit or 'all'}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        query = """
        SELECT Id, AccountId, Account.Name, FirstName, LastName, Name,
               Salutation, Title, Department, Email, Phone, MobilePhone,
               MailingStreet, MailingCity, MailingState, MailingPostalCode, MailingCountry,
               OwnerId, Owner.Name, LeadSource, Birthdate, Description,
               DoNotCall, HasOptedOutOfEmail, RecordTypeId, RecordType.Name,
               CreatedDate, LastModifiedDate, LastActivityDate,
               npsp__Primary_Affiliation__c, npsp__Primary_Affiliation__r.Name,
               npsp__Deceased__c, npsp__Do_Not_Contact__c,
               npe01__WorkEmail__c, npe01__HomeEmail__c, npe01__AlternateEmail__c,
               npe01__WorkPhone__c, npe01__PreferredPhone__c, npe01__Preferred_Email__c,
               npe01__Primary_Address_Type__c,
               Preferred_Name__c, Pronouns__c, Gender__c, LinkedIn_URL__c,
               Philanthropic_Contact__c, Philanthropy__c, Board_Status__c,
               Volunteer__c, Added_to_Slack__c, Last_Touchpoint__c,
               Last_Activity_Date__c, Days_Since_Last_Activity__c,
               Primary_Affiliation_Entity__c, Primary_Affiliation_Name__c,
               GW_Volunteers__Volunteer_Hours__c, GW_Volunteers__Last_Volunteer_Date__c
        FROM Contact
        """

        if account_id:
            validate_salesforce_id(account_id, "account_id")
            query += f" WHERE AccountId = '{account_id}'"

        query += " ORDER BY LastName ASC"
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        contacts = result.get("records", [])
        cache.set(cache_key, contacts, CACHE_TTL_ACCOUNTS)
        return contacts

    except Exception as e:
        logger.error(f"Error fetching contacts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/salesforce/contacts")
async def create_contact(
    contact_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("create_contacts"))
):
    """Create a new Salesforce contact."""
    try:
        salesforce = client.salesforce
        
        # Create the contact
        result = await salesforce.create_record("Contact", contact_data)
        
        if result and result.get("id"):
            cache.invalidate_prefix("contacts:")
            logger.info(f"Contact created with ID: {result['id']} by {user['user_id']}")
            return ApiResponse(success=True, data={"id": result["id"], "message": "Contact created successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to create contact")
            
    except Exception as e:
        logger.error(f"Error creating contact: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Payment SOQL (shared by both payment GET endpoints) ──────────────────

PAYMENT_SOQL_FIELDS = """
    Id, Name, npe01__Opportunity__c, npe01__Opportunity__r.Name,
    npe01__Opportunity__r.Account.Name,
    npe01__Payment_Amount__c, npe01__Scheduled_Date__c,
    npe01__Payment_Date__c, npe01__Paid__c,
    npe01__Payment_Method__c, npe01__Check_Reference_Number__c,
    npe01__Written_Off__c, Write_off_reason__c,
    Amount_Received__c, Department__c, GL_Account__c,
    GL_Payment_Received__c, Reconciled_with_Finance__c,
    Batch_Name__c, Payment_Estimate__c, Invoice__c,
    Affiliation__c, CreatedDate, LastModifiedDate,
    Payment_Status__c, Delinquent__c, Paid_Status__c,
    Amount_Formula__c, Amount_Minus_Received__c
"""


@app.get("/api/salesforce/payments")
async def get_payments(
    opportunity_id: Optional[str] = None,
    limit: int = Query(500, le=2000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth),
):
    """Get Salesforce payments, optionally filtered by opportunity."""
    try:
        cache_key = f"payments:{opportunity_id}:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce
        query = f"SELECT {PAYMENT_SOQL_FIELDS} FROM npe01__OppPayment__c"

        if opportunity_id:
            validate_salesforce_id(opportunity_id, "opportunity_id")
            query += f" WHERE npe01__Opportunity__c = '{opportunity_id}'"

        query += f" ORDER BY npe01__Scheduled_Date__c DESC NULLS LAST LIMIT {limit}"

        result = await salesforce.query(query)
        records = result.get("records", [])
        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        return records

    except Exception as e:
        logger.error(f"Error fetching payments: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/salesforce/opportunities/{opportunity_id}/payments")
async def get_opportunity_payments(
    opportunity_id: str,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth),
):
    """Get all payments for a specific opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        cache_key = f"opp-payments:{opportunity_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce
        query = f"""
        SELECT {PAYMENT_SOQL_FIELDS}
        FROM npe01__OppPayment__c
        WHERE npe01__Opportunity__c = '{opportunity_id}'
        ORDER BY npe01__Scheduled_Date__c ASC NULLS LAST
        """

        result = await salesforce.query(query)
        records = result.get("records", [])
        cache.set(cache_key, records, CACHE_TTL_OPPORTUNITIES)
        return records

    except Exception as e:
        logger.error(f"Error fetching payments for opportunity {opportunity_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Update endpoints for Account, Contact, Payment ──────────────────────

class AccountUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class ContactUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class PaymentUpdateRequest(BaseModel):
    updates: Dict[str, Any]
    reason: Optional[str] = None


class PaymentCreateRequest(BaseModel):
    """Request body for single-record Payment create.

    Distinct from routes/payment_schedules.py's bulk CreatePaymentScheduleRequest,
    which wipes and re-creates every payment for an opportunity. This endpoint
    appends a single new npe01__OppPayment__c record to whatever already exists.

    Hardened 2026-04-21 post-adversarial review (PR #161): amount bounded and
    positive-only (blocks negative-amount exploit + NaN/Infinity); scheduled_date
    strict YYYY-MM-DD (blocks 10MB-string DoS + SOQL-payload fuzzing); extra
    fields forbidden (blocks field-injection probing).
    """
    opportunity_id: str
    amount: float
    scheduled_date: str  # YYYY-MM-DD
    payment_method: Optional[str] = None
    paid: bool = False

    class Config:
        extra = "forbid"

    @validator("amount")
    def _amount_positive_and_bounded(cls, v):
        import math
        if math.isnan(v) or math.isinf(v):
            raise ValueError("amount must be a finite number")
        if v <= 0:
            raise ValueError("amount must be greater than 0")
        # Sanity bound — no single payment should be larger than $1 trillion.
        # Catches accidental 1e308 / precision-loss attacks.
        if v > 1_000_000_000_000:
            raise ValueError("amount is unreasonably large")
        return v

    @validator("scheduled_date")
    def _scheduled_date_strict_iso(cls, v):
        from datetime import datetime as _dt
        if not isinstance(v, str) or len(v) != 10:
            raise ValueError("scheduled_date must be exactly YYYY-MM-DD")
        try:
            _dt.strptime(v, "%Y-%m-%d")
        except ValueError:
            raise ValueError("scheduled_date must be a valid YYYY-MM-DD date")
        return v

    @validator("payment_method")
    def _payment_method_bounded(cls, v):
        if v is None:
            return v
        if not isinstance(v, str):
            raise ValueError("payment_method must be a string")
        # SF picklist values max at 255 chars; anything larger is an attack
        # payload or a mistake.
        if len(v) > 255:
            raise ValueError("payment_method exceeds 255 chars")
        return v


async def _enforce_opp_ownership_for_payment(
    salesforce,
    opportunity_id: str,
    user: Dict[str, Any],
) -> None:
    """Raise HTTPException(403/404) unless `user` may mutate payments on
    `opportunity_id`.

    Mirrors the pattern used by `update_opportunity` (main.py:425-436): admin
    or `edit_all_opportunities` bypasses the check; otherwise the caller's
    `sf_user_id` must match the Opportunity's `OwnerId`.

    Added 2026-04-21 post-adversarial review (PR #163). Previously,
    `check_permission("edit_payments")` alone gated POST/DELETE — any user
    with that permission could create/delete payments on any opportunity,
    including ones they didn't own. This helper restores parity with the
    opportunity-update permission model.
    """
    perms = user.get("_permissions", {})
    if perms.get("manage_users_roles", False):
        return  # Admin bypass
    if perms.get("edit_all_opportunities", False):
        return  # Global edit bypass — same as update_opportunity
    sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
    if not sf_user_id:
        # User exists in Bedrock but isn't linked to a Salesforce user —
        # we can't evaluate ownership, so deny. Consistent with the
        # edit-own-opps flow; safer than permitting.
        raise HTTPException(
            status_code=403,
            detail="Cannot verify opportunity ownership — user is not linked to a Salesforce user",
        )
    safe_opp = escape_soql_string(opportunity_id)
    result = await salesforce.query(
        f"SELECT OwnerId FROM Opportunity WHERE Id = '{safe_opp}' LIMIT 1"
    )
    records = result.get("records", [])
    if not records:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    if records[0].get("OwnerId") != sf_user_id:
        raise HTTPException(
            status_code=403,
            detail="You can only modify payments on opportunities you own",
        )


@app.put("/api/salesforce/accounts/{account_id}")
async def update_account(
    account_id: str,
    update_request: AccountUpdateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("edit_accounts")),
):
    """Update a Salesforce account."""
    validate_salesforce_id(account_id, "account_id")
    try:
        salesforce = client.salesforce
        success = await salesforce.update_record("Account", account_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        cache.invalidate_prefix("accounts:")
        logger.info(f"Account {account_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data={"id": account_id, "message": "Account updated"})
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error updating account {account_id}: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)


@app.put("/api/salesforce/contacts/{contact_id}")
async def update_contact(
    contact_id: str,
    update_request: ContactUpdateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("edit_contacts")),
):
    """Update a Salesforce contact."""
    validate_salesforce_id(contact_id, "contact_id")
    try:
        salesforce = client.salesforce
        success = await salesforce.update_record("Contact", contact_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        cache.invalidate_prefix("contacts:")
        logger.info(f"Contact {contact_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data={"id": contact_id, "message": "Contact updated"})
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error updating contact {contact_id}: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)


@app.put("/api/salesforce/payments/{payment_id}")
@limiter.limit("30/minute")
async def update_payment(
    request: Request,
    payment_id: str,
    update_request: PaymentUpdateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("edit_payments")),
):
    """Update a Salesforce payment (npe01__OppPayment__c).

    Auth: `check_permission("edit_payments")` is the outer gate. PR #164 added
    opp-ownership parity with POST/DELETE — the endpoint now resolves the
    payment's parent Opp (cheap SOQL) and defers to
    `_enforce_opp_ownership_for_payment`. Non-owner updates are rejected
    unless the caller is admin or has `edit_all_opportunities`.

    Rate-limited at 30/minute per IP so a compromised account with
    edit_payments can't bulk-update SF records."""
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce
        # Ownership gate — same parent-lookup pattern as delete_payment.
        safe_id = escape_soql_string(payment_id)
        parent_result = await salesforce.query(
            f"SELECT npe01__Opportunity__c FROM npe01__OppPayment__c WHERE Id = '{safe_id}' LIMIT 1"
        )
        parent_records = parent_result.get("records", [])
        if not parent_records:
            raise HTTPException(status_code=404, detail="Payment not found")
        parent_opp_id = parent_records[0].get("npe01__Opportunity__c")
        if parent_opp_id:
            await _enforce_opp_ownership_for_payment(salesforce, parent_opp_id, user)
        # Ownership OK — proceed with the update.
        success = await salesforce.update_record("npe01__OppPayment__c", payment_id, update_request.updates)
        if not success:
            raise HTTPException(400, "Salesforce rejected the update")
        # Rollup fields on the parent Opp may change when payment fields
        # (Amount, Paid, etc.) change — invalidate that cache too.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Payment {payment_id} updated by {user['user_id']}")
        return ApiResponse(success=True, data={"id": payment_id, "message": "Payment updated"})
    except HTTPException:
        raise
    except Exception as e:
        # Sanitized client error; full detail server-side (matches POST/DELETE).
        logger.error(
            f"Error updating payment {payment_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to update payment. Check server logs or contact support.",
        )


@app.delete("/api/salesforce/payments/{payment_id}")
@limiter.limit("30/minute")
async def delete_payment(
    request: Request,
    payment_id: str,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("edit_payments")),
):
    """Delete a Salesforce Payment (npe01__OppPayment__c).

    Destructive and irreversible at the SF level — the frontend caller
    (PaymentEditDialog) is expected to surface a confirm-before-delete
    dialog.

    Auth: `check_permission("edit_payments")` is the outer gate. This endpoint
    takes only `payment_id`, so we first resolve the parent Opp via a cheap
    SOQL query (also gives us a 404 if the payment doesn't exist), then
    defer to `_enforce_opp_ownership_for_payment` — non-owner deletes are
    rejected unless the caller is admin or has `edit_all_opportunities`
    (PR #163 hardening)."""
    validate_salesforce_id(payment_id, "payment_id")
    try:
        salesforce = client.salesforce
        # Resolve parent Opp Id so we can run the ownership check. If the
        # payment doesn't exist at all, 404 out before attempting delete.
        safe_id = escape_soql_string(payment_id)
        parent_result = await salesforce.query(
            f"SELECT npe01__Opportunity__c FROM npe01__OppPayment__c WHERE Id = '{safe_id}' LIMIT 1"
        )
        parent_records = parent_result.get("records", [])
        if not parent_records:
            raise HTTPException(status_code=404, detail="Payment not found")
        parent_opp_id = parent_records[0].get("npe01__Opportunity__c")
        if parent_opp_id:
            await _enforce_opp_ownership_for_payment(salesforce, parent_opp_id, user)
        # Ownership OK — proceed with the destructive action.
        success = await salesforce.delete_record("npe01__OppPayment__c", payment_id)
        if not success:
            raise HTTPException(400, "Salesforce rejected the delete")
        # Same cache-invalidation surface as create: rollup fields on the
        # parent Opportunity update when a payment goes away.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(f"Payment {payment_id} deleted by {user['user_id']}")
        return ApiResponse(
            success=True,
            data={"id": payment_id, "message": "Payment deleted"},
        )
    except HTTPException:
        raise
    except Exception as e:
        # Full detail server-side for debugging; generic message to the client
        # so we don't leak SF internal error text (field names, instance URLs,
        # rate-limit hints). See adversarial review notes on PR #161.
        logger.error(
            f"Error deleting payment {payment_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to delete payment. Check server logs or contact support.",
        )


@app.post("/api/salesforce/payments")
@limiter.limit("30/minute")
async def create_payment(
    request: Request,
    create_request: PaymentCreateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("edit_payments")),
):
    """Create a single Salesforce Payment (npe01__OppPayment__c) on an existing
    opportunity.

    Use this (not the bulk routes/payment_schedules.py POST) when appending
    one additional payment to whatever schedule already exists — no delete,
    no validation that the sum matches the Opportunity Amount. The Opp
    dialog's inline Payment Schedule accordion calls this on "+ Add Payment".

    Auth: `check_permission("edit_payments")` is the outer gate; then
    `_enforce_opp_ownership_for_payment` rejects non-owner writes unless the
    caller is admin or has `edit_all_opportunities` (PR #163 hardening).
    """
    validate_salesforce_id(create_request.opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        # Ownership gate before any SF mutation.
        await _enforce_opp_ownership_for_payment(
            salesforce, create_request.opportunity_id, user,
        )
        fields: Dict[str, Any] = {
            "npe01__Opportunity__c": create_request.opportunity_id,
            "npe01__Payment_Amount__c": create_request.amount,
            "npe01__Scheduled_Date__c": create_request.scheduled_date,
            "npe01__Paid__c": create_request.paid,
        }
        if create_request.payment_method:
            fields["npe01__Payment_Method__c"] = create_request.payment_method
        result = await salesforce.create_record("npe01__OppPayment__c", fields)
        # Rollup fields on the parent Opp change when a new payment lands, so
        # invalidate both the payment caches and the opportunities cache.
        cache.invalidate_prefix("payments:")
        cache.invalidate_prefix("opp-payments:")
        cache.invalidate_prefix("opportunities:")
        logger.info(
            f"Payment created by {user['user_id']} on opp {create_request.opportunity_id}"
        )
        return ApiResponse(
            success=True,
            data={"id": result.get("id"), "message": "Payment created"},
        )
    except HTTPException:
        raise
    except Exception as e:
        # Full detail server-side for debugging; generic message to the client
        # so we don't leak SF internal error text (field names, instance URLs,
        # rate-limit hints). See adversarial review notes on PR #161.
        logger.error(
            f"Error creating payment on opp {create_request.opportunity_id}: {str(e)}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=400,
            detail="Failed to create payment. Check server logs or contact support.",
        )


@app.get("/api/salesforce/users")
async def get_users(
    limit: int = Query(1000, le=5000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce users (active + inactive, grouped by IsActive)."""
    try:
        cache_key = f"users:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        query = f"""
        SELECT Id, Name, Email, IsActive
        FROM User
        ORDER BY IsActive DESC, Name ASC
        LIMIT {limit}
        """

        result = await salesforce.query(query)
        users = result.get("records", [])
        cache.set(cache_key, users, CACHE_TTL_USERS)
        return users

    except Exception as e:
        logger.error(f"Error fetching users: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# My Tasks / Calendar endpoints (for My Priorities page)
# ---------------------------------------------------------------------------

@app.get("/api/salesforce/my-tasks")
async def get_my_tasks(
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    # Stays on salesforce.query() (not query_all): the WHERE clause
    # (IsClosed = false + optional date range) scope-bounds per-user open
    # Task counts well under 2000 at Pursuit's team-of-4 scale. Revisit if
    # any single user's open-Task count ever approaches the cap.
    limit: int = Query(2000, le=2000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get current user's Salesforce Tasks in a date range."""
    try:
        if "salesforce" not in (client.connected_services or []):
            return []
        cache_key = f"my-tasks:{start}:{end}:{limit}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        salesforce = client.salesforce

        where_clauses = ["IsClosed = false"]
        if start:
            where_clauses.append(f"ActivityDate >= {start}")
        if end:
            where_clauses.append(f"ActivityDate <= {end}")

        where_sql = " AND ".join(where_clauses)
        query = f"""
        SELECT Id, Subject, ActivityDate, Status, Priority, WhatId, WhoId, Who.Name,
               OwnerId, Owner.Name, CreatedById, CreatedBy.Name, Description, CreatedDate, LastModifiedDate
        FROM Task
        WHERE {where_sql}
        ORDER BY ActivityDate ASC
        LIMIT {limit}
        """

        result = await salesforce.query(query)
        tasks = result.get("records", [])
        response = ApiResponse(success=True, data=tasks, meta={"count": len(tasks)})
        cache.set(cache_key, response, 120)  # 2 min TTL — tasks change frequently
        return response

    except Exception as e:
        logger.error(f"Error fetching tasks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Salesforce Task CRUD (linked to Opportunities)
# ---------------------------------------------------------------------------

class TaskCreateRequest(BaseModel):
    Subject: str
    Status: str = "Not Started"
    Priority: str = "Normal"
    ActivityDate: Optional[str] = None
    Description: Optional[str] = None
    OwnerId: Optional[str] = None


class TaskUpdateRequest(BaseModel):
    Subject: Optional[str] = None
    Status: Optional[str] = None
    Priority: Optional[str] = None
    ActivityDate: Optional[str] = None
    Description: Optional[str] = None
    OwnerId: Optional[str] = None
    WhatId: Optional[str] = None


class TaskDuplicateRequest(BaseModel):
    WhatId: Optional[str] = None  # Opportunity to link the duplicate to


@app.get("/api/salesforce/opportunities/{opportunity_id}/tasks")
async def get_opportunity_tasks(
    opportunity_id: str,
    # Default `None` returns all Tasks for the opportunity via query_all
    # pagination. `le=2000` caps callers that request an explicit limit.
    limit: Optional[int] = Query(None, le=2000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get all tasks linked to a specific opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               OwnerId, Owner.Name, WhoId, Who.Name, WhatId, Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE WhatId = '{opportunity_id}'
        ORDER BY ActivityDate DESC NULLS LAST
        """
        if limit is not None:
            query += f" LIMIT {limit}"

        result = await salesforce.query_all(query)
        tasks = result.get("records", [])

        formatted = []
        for t in tasks:
            formatted.append({
                "Id": t.get("Id"),
                "Subject": t.get("Subject"),
                "Status": t.get("Status"),
                "Priority": t.get("Priority"),
                "ActivityDate": t.get("ActivityDate"),
                "Description": t.get("Description"),
                "OwnerId": t.get("OwnerId"),
                "OwnerName": (t.get("Owner") or {}).get("Name"),
                "WhoId": t.get("WhoId"),
                "WhoName": (t.get("Who") or {}).get("Name"),
                "Type": t.get("Type"),
                "TaskSubtype": t.get("TaskSubtype"),
                "CreatedById": t.get("CreatedById"),
                "CreatedByName": (t.get("CreatedBy") or {}).get("Name"),
                "CreatedDate": t.get("CreatedDate"),
                "LastModifiedDate": t.get("LastModifiedDate"),
                "WhatId": t.get("WhatId"),
            })

        return ApiResponse(success=True, data=formatted, meta={"count": len(formatted)})
    except Exception as e:
        logger.error(f"Error fetching opportunity tasks: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/salesforce/opportunities/{opportunity_id}/tasks")
async def create_opportunity_task(
    opportunity_id: str,
    task_data: TaskCreateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("create_tasks")),
    db=Depends(get_db),
):
    """Create a new task linked to an opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        # Check if the target opportunity is locked
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
        )
        if lock:
            perms = user.get("_permissions", {})
            sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
            if lock["locked_by"] != sf_user_id and not perms.get("manage_users_roles", False):
                raise HTTPException(403, "Cannot create tasks on a locked opportunity")
        salesforce = client.salesforce
        fields = {"WhatId": opportunity_id, **task_data.model_dump(exclude_none=True)}
        result = await salesforce.create_record("Task", fields)
        task_id = result.get("id") or result.get("Id")
        cache.invalidate_prefix("my-tasks:")
        return ApiResponse(success=True, data={"id": task_id, "message": "Task created"})
    except Exception as e:
        logger.error(f"Error creating task: {e}")
        raise HTTPException(status_code=500, detail="Failed to create task")


@app.put("/api/salesforce/tasks/{task_id}")
async def update_task(
    task_id: str,
    updates: TaskUpdateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("edit_own_tasks")),
    db=Depends(get_db),
):
    """Update an existing Salesforce task. Respects opportunity locks."""
    validate_salesforce_id(task_id, "task_id")
    try:
        salesforce = client.salesforce
        # Server-side lock resolution — fetches task's actual WhatId + OwnerId from SF
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)

        fields = updates.model_dump(exclude_none=True)
        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")

        if lock_info["is_locked"]:
            if lock_info["is_lock_owner"] or lock_info["is_admin"]:
                pass  # Full access
            elif lock_info["is_task_owner"]:
                # Task owner: allow field updates but BLOCK WhatId changes
                if updates.WhatId and updates.WhatId != lock_info["what_id"]:
                    raise HTTPException(403, "Cannot move task from a locked opportunity")
                fields.pop("WhatId", None)  # Strip WhatId to prevent relocation
            else:
                raise HTTPException(403, "This task's opportunity is locked")

        await salesforce.update_record("Task", task_id, fields)
        cache.invalidate_prefix("my-tasks:")
        return ApiResponse(success=True, data={"message": "Task updated"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating task: {e}")
        raise HTTPException(status_code=500, detail="Failed to update task")


@app.delete("/api/salesforce/tasks/{task_id}")
async def delete_task(
    task_id: str,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("edit_own_tasks")),
    db=Depends(get_db),
):
    """Delete a Salesforce task. Blocked on locked opportunities."""
    validate_salesforce_id(task_id, "task_id")
    try:
        salesforce = client.salesforce
        # Check if task's opportunity is locked — only lock owner + admin can delete
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)
        if lock_info["is_locked"] and not lock_info["is_lock_owner"] and not lock_info["is_admin"]:
            raise HTTPException(403, "Cannot delete tasks from a locked opportunity")
        await salesforce.delete_record("Task", task_id)
        cache.invalidate_prefix("my-tasks:")
        return ApiResponse(success=True, data={"message": "Task deleted"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting task: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete task")


@app.post("/api/salesforce/tasks/{task_id}/duplicate")
async def duplicate_task(
    task_id: str,
    body: TaskDuplicateRequest,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(check_permission("create_tasks")),
    db=Depends(get_db),
):
    """Duplicate a Salesforce task, optionally linking to a different opportunity."""
    validate_salesforce_id(task_id, "task_id")
    if body.WhatId is not None:
        validate_salesforce_id(body.WhatId, "WhatId")
    try:
        salesforce = client.salesforce
        # Check if source task's opportunity is locked
        lock_info = await resolve_task_lock(task_id, user, db, salesforce)
        if lock_info["is_locked"] and not lock_info["is_lock_owner"] and not lock_info["is_admin"]:
            raise HTTPException(403, "Cannot duplicate tasks from a locked opportunity")
        # Check if destination opportunity is locked
        dest_opp = body.WhatId
        if dest_opp:
            dest_lock = await db.fetchrow(
                "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", dest_opp
            )
            if dest_lock:
                perms = user.get("_permissions", {})
                sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
                if dest_lock["locked_by"] != sf_user_id and not perms.get("manage_users_roles", False):
                    raise HTTPException(403, "Cannot duplicate tasks to a locked opportunity")
        # Fetch the original task
        safe_id = escape_soql_string(task_id)
        result = await salesforce.query(
            f"SELECT Subject, Status, Priority, ActivityDate, Description, OwnerId, WhatId "
            f"FROM Task WHERE Id = '{safe_id}'"
        )
        records = result.get("records", [])
        if not records:
            raise HTTPException(status_code=404, detail="Task not found")
        original = records[0]
        # Build the new task fields, copying from original
        fields = {
            "Subject": original.get("Subject", ""),
            "Status": original.get("Status", "Not Started"),
            "Priority": original.get("Priority", "Normal"),
        }
        if original.get("ActivityDate"):
            fields["ActivityDate"] = original["ActivityDate"]
        if original.get("Description"):
            fields["Description"] = original["Description"]
        if original.get("OwnerId"):
            fields["OwnerId"] = original["OwnerId"]
        # Use provided WhatId or keep original
        if body.WhatId is not None:
            fields["WhatId"] = body.WhatId
        elif original.get("WhatId"):
            fields["WhatId"] = original["WhatId"]
        new_task = await salesforce.create_record("Task", fields)
        new_id = new_task.get("id") or new_task.get("Id")
        cache.invalidate_prefix("my-tasks:")
        return ApiResponse(success=True, data={"id": new_id, "message": "Task duplicated"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error duplicating task: {e}")
        raise HTTPException(status_code=500, detail="Failed to duplicate task")


@app.get("/api/calendar/my-events")
async def get_my_calendar_events(
    request: Request,
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    limit: int = Query(100, le=200),
    calendar_id: Optional[str] = Query(None, description="Calendar ID"),
    user=Depends(require_auth),
):
    """Get Google Calendar events from the PBD shared calendar using per-user OAuth credentials."""
    # Restrict to PBD calendar only
    if not calendar_id or calendar_id == "primary" or calendar_id != PBD_CALENDAR_ID:
        return {
            "data": [],
            "total": 0,
            "error": "Calendar ID mismatch — only the PBD shared calendar is supported.",
        }

    try:
        email = user.get("email")
        if not email:
            return {"data": [], "total": 0, "error": "No email in user profile.", "needs_reauth": True}

        creds = get_google_credentials(email, request)
        if not creds:
            return {
                "data": [],
                "total": 0,
                "error": "Google tokens not available. Please re-login to grant Calendar access.",
                "needs_reauth": True,
            }

        from googleapiclient.discovery import build

        loop = asyncio.get_event_loop()

        def _fetch_events():
            service = build("calendar", "v3", credentials=creds)
            params = {
                "calendarId": calendar_id,
                "maxResults": limit,
                "singleEvents": True,
                "orderBy": "startTime",
            }
            if start:
                params["timeMin"] = start if "T" in start else f"{start}T00:00:00Z"
            if end:
                params["timeMax"] = end if "T" in end else f"{end}T23:59:59Z"
            result = service.events().list(**params).execute()
            return result.get("items", [])

        raw_events = await loop.run_in_executor(None, _fetch_events)

        events = []
        for ev in raw_events:
            s = ev.get("start", {})
            e = ev.get("end", {})
            events.append({
                "id": ev.get("id"),
                "summary": ev.get("summary", "(No title)"),
                "start": s.get("dateTime") or s.get("date"),
                "end": e.get("dateTime") or e.get("date"),
                "attendees": [
                    {"email": a.get("email"), "name": a.get("displayName"), "status": a.get("responseStatus")}
                    for a in ev.get("attendees", [])
                ],
                "location": ev.get("location"),
                "description": (ev.get("description") or "")[:300],
                "status": ev.get("status"),
                "htmlLink": ev.get("htmlLink"),
            })

        return {"data": events, "total": len(events)}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Calendar my-events error: {e}")
        err_str = str(e).lower()
        if "invalid_grant" in err_str or "token" in err_str or "credentials" in err_str:
            return {
                "data": [],
                "total": 0,
                "error": "Calendar token expired. Please re-login.",
                "needs_reauth": True,
            }
        # Return structured error instead of 500 so frontend can display it
        return {
            "data": [],
            "total": 0,
            "error": f"Calendar error: {e}",
        }


# Sage Intacct endpoints

@app.get("/api/intacct/invoices", response_model=List[IntacctInvoice])
async def get_invoices(
    customer_id: Optional[str] = None,
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Sage Intacct invoices."""
    try:
        intacct = client.sage_intacct
        
        result = await intacct.get_invoices(customer_id=customer_id, limit=limit)
        
        invoices = []
        if result.get("success") and result.get("data"):
            invoice_data = result["data"] if isinstance(result["data"], list) else [result["data"]]
            for record in invoice_data:
                invoices.append(IntacctInvoice(**record))
        
        return invoices
        
    except Exception as e:
        logger.error(f"Error fetching invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/intacct/invoices")
async def create_invoice(
    invoice_request: InvoiceCreationRequest,
    background_tasks: BackgroundTasks,
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission("create_sage_invoices"))
):
    """Create a new invoice in Sage Intacct."""
    try:
        intacct = client.sage_intacct
        
        # Prepare invoice data
        invoice_data = {
            "customer_id": invoice_request.customer_id,
            "date_created": datetime.now().strftime("%m/%d/%Y"),
            "line_items": invoice_request.line_items
        }
        
        result = await intacct.create_invoice(invoice_data)
        
        if result.get("success"):
            # Schedule background task to update opportunity mapping
            background_tasks.add_task(
                update_opportunity_invoice_mapping,
                invoice_request.opportunity_id,
                result.get("data", {}).get("RECORDNO"),
                user["user_id"]
            )
            
            return ApiResponse(
                success=True,
                data={"invoice_id": result.get("data", {}).get("RECORDNO"), "message": "Invoice created successfully"},
            )
        else:
            raise HTTPException(
                status_code=400, 
                detail=f"Failed to create invoice: {result.get('errors', ['Unknown error'])}"
            )
            
    except Exception as e:
        logger.error(f"Error creating invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/intacct/payments", response_model=List[IntacctPayment])
async def get_payments(
    customer_id: Optional[str] = None,
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Sage Intacct payments."""
    try:
        intacct = client.sage_intacct
        
        result = await intacct.get_payments(customer_id=customer_id, limit=limit)
        
        payments = []
        if result.get("success") and result.get("data"):
            payment_data = result["data"] if isinstance(result["data"], list) else [result["data"]]
            for record in payment_data:
                payments.append(IntacctPayment(**record))
        
        return payments
        
    except Exception as e:
        logger.error(f"Error fetching payments: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Forecasting endpoints

@app.get("/api/forecasting/dashboard", response_model=ForecastingDashboardData)
async def get_forecasting_dashboard(
    date_range_days: int = Query(90, ge=30, le=365),
    scenario: str = Query("realistic"),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get forecasting dashboard data."""
    try:
        end_date = date.today() + timedelta(days=date_range_days)
        start_date = date.today()
        
        dashboard_data = await engine.generate_dashboard_data(
            start_date=start_date,
            end_date=end_date,
            scenario=scenario
        )
        
        return dashboard_data
        
    except Exception as e:
        logger.error(f"Error generating dashboard data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/payment-forecast", response_model=List[PaymentForecast])
async def get_payment_forecast(
    days_ahead: int = Query(90, ge=30, le=365),
    min_probability: int = Query(0, ge=0, le=100),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get payment forecast for opportunities."""
    try:
        forecasts = await engine.generate_payment_forecasts(
            days_ahead=days_ahead,
            min_probability=min_probability
        )
        
        return forecasts
        
    except Exception as e:
        logger.error(f"Error generating payment forecast: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/cash-flow", response_model=List[CashFlowProjection])
async def get_cash_flow_projection(
    months_ahead: int = Query(6, ge=1, le=24),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get cash flow projections."""
    try:
        projections = await engine.generate_cash_flow_projections(
            months_ahead=months_ahead
        )
        
        return projections
        
    except Exception as e:
        logger.error(f"Error generating cash flow projections: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/forecasting/metrics", response_model=ForecastingMetrics)
async def get_forecasting_metrics(
    engine: ForecastingEngine = Depends(get_forecasting_engine),
    user = Depends(require_auth)
):
    """Get key forecasting metrics."""
    try:
        metrics = await engine.calculate_forecasting_metrics()
        return metrics
        
    except Exception as e:
        logger.error(f"Error calculating metrics: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecasting/generate-report", response_model=ForecastingReport)
async def generate_forecasting_report(
    background_tasks: BackgroundTasks,
    period_days: int = Query(90, ge=30, le=365),
    user = Depends(check_permission("generate_financial_reports")),
    engine: ForecastingEngine = Depends(get_forecasting_engine),
):
    """Generate comprehensive forecasting report."""
    try:
        start_date = date.today()
        end_date = start_date + timedelta(days=period_days)
        
        report = await engine.generate_comprehensive_report(
            start_date=start_date,
            end_date=end_date,
            user_id=user["user_id"]
        )
        
        # Schedule background task to save/email report
        background_tasks.add_task(
            save_and_notify_report,
            report,
            user["user_id"]
        )
        
        return report
        
    except Exception as e:
        logger.error(f"Error generating report: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Data sync endpoints

@app.post("/api/sync/trigger")
async def trigger_data_sync(
    background_tasks: BackgroundTasks,
    sync_type: str = Query("all", regex="^(all|salesforce|intacct)$"),
    user = Depends(check_permission("trigger_data_sync")),
    sync_service: DataSyncService = Depends(get_data_sync_service),
):
    """Trigger manual data synchronization."""
    try:

        if _sync_lock.locked():
            raise HTTPException(status_code=409, detail="Sync already in progress")

        async def _locked_sync(sync_fn):
            async with _sync_lock:
                await sync_fn()

        if sync_type == "all":
            background_tasks.add_task(_locked_sync, sync_service.sync_all_data)
        elif sync_type == "salesforce":
            background_tasks.add_task(_locked_sync, sync_service.sync_salesforce_data)
        elif sync_type == "intacct":
            background_tasks.add_task(_locked_sync, sync_service.sync_intacct_data)

        return ApiResponse(
            success=True,
            data={"message": f"Data sync ({sync_type}) triggered successfully"},
            meta={"triggered_by": user["user_id"]},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error triggering sync: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Cache management

@app.post("/api/cache/clear")
async def clear_cache(user=Depends(require_auth)):
    """Clear all server-side caches."""
    cache.clear()
    return {"message": "All caches cleared"}


# Invoice Matching endpoints

class InvoiceMatchRequest(BaseModel):
    """Request model for matching an invoice to an opportunity."""
    invoice_id: str
    opportunity_id: str
    confidence: str = "Confirmed"
    notes: Optional[str] = None
    customer_name: Optional[str] = None
    invoice_amount: Optional[float] = None
    invoice_date: Optional[str] = None


def calculate_match_score(opp, customer_name, invoice_amount, invoice_date):
    """Calculate match score between an invoice and an opportunity.

    Weights: name 40%, amount 30%, date proximity 20%, stage bonus ±flat.
    """
    score = 0
    explanation = {}

    # Name matching (40% weight)
    if customer_name and opp.get("AccountName"):
        name_ratio = SequenceMatcher(
            None, customer_name.lower(), opp["AccountName"].lower()
        ).ratio() * 100
        score += name_ratio * 0.4
        explanation["name_match"] = name_ratio

    # Amount matching (30% weight)
    if invoice_amount and opp.get("Amount"):
        opp_amount = float(opp["Amount"])
        amount_diff = abs(opp_amount - invoice_amount)
        amount_ratio = max(0, 100 - (amount_diff / max(opp_amount, invoice_amount) * 100))
        score += amount_ratio * 0.3
        explanation["amount_match"] = amount_ratio

    # Date proximity (20% weight)
    if invoice_date and opp.get("CloseDate"):
        try:
            inv_date = datetime.strptime(invoice_date, "%Y-%m-%d")
            close_date = datetime.strptime(opp["CloseDate"], "%Y-%m-%d")
            days_diff = abs((inv_date - close_date).days)

            if days_diff <= 30:
                date_score = 100
            elif days_diff <= 90:
                date_score = 100 - ((days_diff - 30) * 1.5)
            elif days_diff <= 180:
                date_score = max(0, 10 - ((days_diff - 90) / 30))
            else:
                date_score = 0

            score += date_score * 0.2
            explanation["date_proximity_days"] = days_diff
        except (ValueError, TypeError):
            pass

    # Stage weighting (flat bonus/penalty)
    stage = opp.get("StageName", "")
    _collecting_values = {s.value for s in COLLECTING_STAGES}
    _open_values = {s.value for s in OPEN_STAGES}
    if stage in _collecting_values:
        score += 30
        explanation["stage_bonus"] = "Active collection"
    elif stage == OpportunityStage.CLOSED_COMPLETED.value:
        score += 25
        explanation["stage_bonus"] = "Completed"
    elif stage in (
        OpportunityStage.CLOSED_LOST.value,
        OpportunityStage.CLOSED_DID_NOT_FULFILL.value,
        OpportunityStage.WITHDRAWN.value,
    ):
        score -= 20
        explanation["stage_bonus"] = "Closed/Lost"
    elif stage in _open_values:
        score -= 10
        explanation["stage_bonus"] = "Open pipeline (not yet won)"
    else:
        score -= 10
        explanation["stage_bonus"] = "Unknown stage"

    return score, explanation


@app.get("/api/matching/search-opportunities")
async def search_opportunities(
    q: str = "",
    limit: int = Query(50, le=200),
    customer_name: Optional[str] = Query(None),
    invoice_amount: Optional[float] = Query(None),
    invoice_date: Optional[str] = Query(None),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Search Salesforce opportunities by name or account with smart matching."""
    try:
        salesforce = client.salesforce

        fields = (
            "Id, Name, AccountId, Account.Name, Amount, StageName, "
            "CloseDate, Description"
        )

        if q:
            safe_q = escape_soql_string(q)
            query = (
                f"SELECT {fields} FROM Opportunity "
                f"WHERE (Name LIKE '%{safe_q}%' OR Account.Name LIKE '%{safe_q}%') "
                f"ORDER BY CloseDate DESC LIMIT {limit}"
            )
        else:
            query = (
                f"SELECT {fields} FROM Opportunity "
                f"ORDER BY CloseDate DESC LIMIT {limit}"
            )

        result = await salesforce.query(query)

        opportunities = []
        for record in result.get("records", []):
            opp_data = {
                "Id": record.get("Id"),
                "Name": record.get("Name"),
                "AccountName": (record.get("Account") or {}).get("Name", ""),
                "Amount": record.get("Amount"),
                "StageName": record.get("StageName"),
                "CloseDate": record.get("CloseDate"),
                "Description": record.get("Description"),
            }

            if customer_name or invoice_amount or invoice_date:
                ms, expl = calculate_match_score(
                    opp_data, customer_name, invoice_amount, invoice_date
                )
                opp_data["matchScore"] = ms
                opp_data["matchExplanation"] = expl

            opportunities.append(opp_data)

        if customer_name or invoice_amount or invoice_date:
            opportunities.sort(key=lambda x: x.get("matchScore", 0), reverse=True)

        return {
            "success": True,
            "count": len(opportunities),
            "opportunities": opportunities,
        }

    except Exception as e:
        logger.error(f"Error searching opportunities: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matching/grant-invoices")
async def get_grant_invoices(
    user = Depends(require_auth)
):
    """Get nonprofit grant invoices for matching."""
    try:
        import pandas as pd
        import os
        
        csv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'nonprofit_grant_invoices.csv')
        
        if not os.path.exists(csv_path):
            raise HTTPException(status_code=404, detail="Grant invoices CSV not found")
        
        df = pd.read_csv(csv_path)
        
        # Convert to list of dicts
        invoices = df.to_dict('records')
        
        return ApiResponse(success=True, data=invoices, meta={"count": len(invoices)})
        
    except Exception as e:
        logger.error(f"Error loading grant invoices: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matching/matches")
async def get_invoice_matches(
    user = Depends(require_auth)
):
    """Get saved invoice-opportunity matches."""
    try:
        import json
        import os
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        if os.path.exists(matches_path):
            with open(matches_path, 'r') as f:
                matches = json.load(f)
        else:
            matches = {}
        
        return ApiResponse(success=True, data=matches, meta={"count": len(matches)})
        
    except Exception as e:
        logger.error(f"Error loading matches: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/matching/save-match")
async def save_invoice_match(
    match_request: InvoiceMatchRequest,
    user = Depends(check_permission("match_invoices"))
):
    """Save an invoice-opportunity match."""
    try:
        import json
        import os
        from datetime import datetime
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        # Load existing matches
        if os.path.exists(matches_path):
            with open(matches_path, 'r') as f:
                matches = json.load(f)
        else:
            matches = {}
        
        # Add/update match
        matches[match_request.invoice_id] = {
            'opportunity_id': match_request.opportunity_id,
            'confidence': match_request.confidence,
            'notes': match_request.notes or '',
            'matched_at': datetime.now().isoformat(),
            'matched_by': user['user_id'],
            'invoice_data': {
                'customer_name': match_request.customer_name or '',
                'invoice_amount': match_request.invoice_amount or 0,
                'invoice_date': match_request.invoice_date or ''
            }
        }
        
        # Save matches
        with open(matches_path, 'w') as f:
            json.dump(matches, f, indent=2)
        
        logger.info(f"Saved match: Invoice {match_request.invoice_id} -> Opportunity {match_request.opportunity_id}")
        
        return ApiResponse(
            success=True,
            data={"message": "Match saved successfully", "invoice_id": match_request.invoice_id, "opportunity_id": match_request.opportunity_id},
        )
        
    except Exception as e:
        logger.error(f"Error saving match: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/matching/delete-match/{invoice_id}")
async def delete_invoice_match(
    invoice_id: str,
    user = Depends(check_permission("match_invoices"))
):
    """Delete an invoice-opportunity match."""
    try:
        import json
        import os
        
        matches_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'invoice_opportunity_matches.json')
        
        if not os.path.exists(matches_path):
            raise HTTPException(status_code=404, detail="No matches found")
        
        # Load matches
        with open(matches_path, 'r') as f:
            matches = json.load(f)
        
        # Delete match
        if invoice_id in matches:
            del matches[invoice_id]
            
            # Save matches
            with open(matches_path, 'w') as f:
                json.dump(matches, f, indent=2)
            
            logger.info(f"Deleted match for invoice {invoice_id}")
            
            return ApiResponse(success=True, data={"message": "Match deleted successfully"})
        else:
            raise HTTPException(status_code=404, detail="Match not found")
        
    except Exception as e:
        logger.error(f"Error deleting match: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Background task functions

async def update_opportunity_invoice_mapping(opportunity_id: str, invoice_id: str, user_id: str):
    """Background task to update opportunity-invoice mapping."""
    try:
        # In a real implementation, this would update a database
        logger.info(f"Updated mapping: Opportunity {opportunity_id} -> Invoice {invoice_id} by {user_id}")
    except Exception as e:
        logger.error(f"Error updating opportunity-invoice mapping: {e}")


async def save_and_notify_report(report: ForecastingReport, user_id: str):
    """Background task to save report and send notifications."""
    try:
        # In a real implementation, this would save to database and send notifications
        logger.info(f"Saved forecasting report {report.report_id} for user {user_id}")
    except Exception as e:
        logger.error(f"Error saving/notifying report: {e}")


# Automation Review, CRM parsing, Slack webhook, and integration endpoints
# have been moved to routes/ai.py, routes/slack_routes.py,
# routes/activity_intelligence.py, and services/crm_parser.py in Phase 2.



# Main entry point
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )

