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
from pydantic import BaseModel
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
    ApiResponse,
)
from forecasting_engine import ForecastingEngine
from data_sync import DataSyncService
from db import init_db, close_db, get_db
from routes.projects import router as projects_router
from routes.auth import router as auth_router
from routes.sf_dependencies import router as sf_deps_router
from routes.permissions import router as permissions_router, opp_router as opp_lock_router, check_permission, check_permission_or_internal, resolve_task_lock
from routes.opportunities_extra import router as opp_extra_router
from routes.payment_schedules import router as payment_schedules_router
from routes.finance import router as finance_router
from routes.sage import router as sage_router
from routes.prospects import router as prospects_router
from routes.activity_intelligence import router as activity_intel_router
from routes.slack_routes import router as slack_router
from routes.ai import router as ai_router
from routes.salesforce_search import router as sf_search_router
from auth import get_current_user_dep, require_auth, IS_PRODUCTION, JWT_SECRET_KEY
from security import validate_salesforce_id, escape_soql_string
from services.crm_parser import refresh_opp_cache as _refresh_opp_cache
from services.cache import cache

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
CORS_ORIGINS = ["http://localhost:3000", "http://localhost:3001"]
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
app.include_router(payment_schedules_router)
app.include_router(finance_router)
app.include_router(sage_router)
app.include_router(prospects_router)
app.include_router(activity_intel_router)
app.include_router(slack_router)
app.include_router(ai_router)
app.include_router(sf_search_router)

# Service singletons — shared with dependencies.py so route files can use
# Depends(get_mcp_client) without circular imports.
import dependencies as _deps
_services = _deps._services
_sync_lock = asyncio.Lock()

# Startup and shutdown events

@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    logger.info("Starting up Financial Forecasting API...")

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


def get_mcp_client() -> UnifiedMCPClient:
    """Get MCP client dependency."""
    client = _services.get("mcp_client")
    if not client:
        raise HTTPException(status_code=503, detail="MCP client not initialized")
    return client


def get_forecasting_engine() -> ForecastingEngine:
    """Get forecasting engine dependency."""
    engine = _services.get("forecasting_engine")
    if not engine:
        raise HTTPException(status_code=503, detail="Forecasting engine not initialized")
    return engine


def get_data_sync_service() -> DataSyncService:
    """Get data sync service dependency."""
    svc = _services.get("data_sync_service")
    if not svc:
        raise HTTPException(status_code=503, detail="Data sync service not available")
    return svc


# Cashflow summary moved to routes/finance.py

# Health check endpoints

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return ApiResponse(
        success=True,
        data={"status": "healthy"},
        meta={
            "timestamp": datetime.utcnow().isoformat(),
            "services": {
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

# Valid stages derived from the OpportunityStage enum — single source of truth
VALID_STAGES = {s.value for s in OpportunityStage}


@app.get("/api/salesforce/opportunities")
async def get_opportunities(
    stage: Optional[OpportunityStage] = None,
    stages: Optional[List[str]] = Query(None),
    limit: int = Query(500, le=2000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce opportunities."""
    try:
        salesforce = client.salesforce

        # Build SOQL query
        query = """
        SELECT Id, AccountId, Account.Name, Name, StageName, Amount, Probability,
               CloseDate, ForecastCategory, LeadSource, NextStep,
               Description, Type, OwnerId, Owner.Name, CreatedDate, LastModifiedDate,
               npe01__Payments_Made__c, Outstanding_Payments__c,
               Number_of_Payments_Received__c, Most_Recent_Payment_Date__c,
               Last_Actual_Payment__c, npe01__Number_of_Payments__c,
               PaymentDate__c, Earliest_Scheduled_Payment__c,
               RecordType.Name, Active_Opportunity__c
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
        if where_clauses:
            query += " WHERE " + " AND ".join(where_clauses)

        query += " ORDER BY CloseDate DESC"

        # Use query_all to get ALL records with automatic pagination
        result = await salesforce.query_all(query)
        records = result.get("records", [])

        # Refresh entity cache for Slack parser
        _refresh_opp_cache(records)

        return records
        
    except Exception as e:
        logger.error(f"Error fetching opportunities: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        # Enforce opportunity lock — only owner or admin can edit locked opportunities
        lock = await db.fetchrow(
            "SELECT locked_by FROM opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
        )
        if lock:
            perms = user.get("_permissions", {})
            sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
            is_lock_owner = (lock["locked_by"] == sf_user_id)
            is_admin = perms.get("manage_users_roles", False)
            if not is_lock_owner and not is_admin:
                raise HTTPException(status_code=403, detail="This opportunity is locked by its owner")

        salesforce = client.salesforce
        success = await salesforce.update_record(
            "Opportunity",
            opportunity_id,
            update_request.updates
        )

        if success:
            logger.info(f"Opportunity {opportunity_id} updated by {user['user_id']}")
            return ApiResponse(success=True, data={"id": opportunity_id, "message": "Opportunity updated successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to update opportunity")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating opportunity: {e}")
        raise HTTPException(status_code=500, detail="Failed to update opportunity")


@app.get("/api/salesforce/accounts")
async def get_accounts(
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce accounts."""
    try:
        salesforce = client.salesforce

        query = f"""
        SELECT Id, Name, Type, Industry
        FROM Account
        ORDER BY Name ASC
        LIMIT {limit}
        """
        
        result = await salesforce.query(query)
        
        return result.get("records", [])
        
    except Exception as e:
        logger.error(f"Error fetching accounts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/salesforce/accounts")
async def create_account(
    account_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("create_opportunities"))
):
    """Create a new Salesforce account."""
    try:
        salesforce = client.salesforce
        
        # Create the account
        result = await salesforce.create_record("Account", account_data)
        
        if result and result.get("id"):
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
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce contacts, optionally filtered by account."""
    try:
        salesforce = client.salesforce

        query = f"""
        SELECT Id, FirstName, LastName, Name, AccountId, Account.Name, Title, Email, Phone,
               npsp__Primary_Affiliation__c, npsp__Primary_Affiliation__r.Name,
               CreatedDate, LastModifiedDate
        FROM Contact
        """

        if account_id:
            validate_salesforce_id(account_id, "account_id")
            query += f" WHERE AccountId = '{account_id}'"
        
        query += f" ORDER BY LastName ASC LIMIT {limit}"
        
        result = await salesforce.query(query)
        
        contacts = []
        for record in result.get("records", []):
            contacts.append(record)
        
        return contacts
        
    except Exception as e:
        logger.error(f"Error fetching contacts: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/salesforce/contacts")
async def create_contact(
    contact_data: Dict[str, Any],
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(check_permission_or_internal("create_opportunities"))
):
    """Create a new Salesforce contact."""
    try:
        salesforce = client.salesforce
        
        # Create the contact
        result = await salesforce.create_record("Contact", contact_data)
        
        if result and result.get("id"):
            logger.info(f"Contact created with ID: {result['id']} by {user['user_id']}")
            return ApiResponse(success=True, data={"id": result["id"], "message": "Contact created successfully"})
        else:
            raise HTTPException(status_code=400, detail="Failed to create contact")
            
    except Exception as e:
        logger.error(f"Error creating contact: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/salesforce/users")
async def get_users(
    limit: int = Query(100, le=1000),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user = Depends(require_auth)
):
    """Get Salesforce users."""
    try:
        salesforce = client.salesforce
        
        query = f"""
        SELECT Id, Name, Email, IsActive
        FROM User
        WHERE IsActive = true
        ORDER BY Name ASC
        LIMIT {limit}
        """
        
        result = await salesforce.query(query)
        
        users = []
        for record in result.get("records", []):
            users.append(record)
        
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
    limit: int = Query(200, le=500),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get current user's Salesforce Tasks in a date range."""
    try:
        salesforce = client.salesforce

        where_clauses = ["IsClosed = false"]
        if start:
            where_clauses.append(f"ActivityDate >= {start}")
        if end:
            where_clauses.append(f"ActivityDate <= {end}")

        where_sql = " AND ".join(where_clauses)
        query = f"""
        SELECT Id, Subject, ActivityDate, Status, Priority, WhatId, WhoId,
               OwnerId, Owner.Name, CreatedById, CreatedBy.Name, Description, CreatedDate, LastModifiedDate
        FROM Task
        WHERE {where_sql}
        ORDER BY ActivityDate ASC
        LIMIT {limit}
        """

        result = await salesforce.query(query)
        tasks = result.get("records", [])
        return ApiResponse(success=True, data=tasks, meta={"count": len(tasks)})

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
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth),
):
    """Get all tasks linked to a specific opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    try:
        salesforce = client.salesforce
        query = f"""
        SELECT Id, Subject, Status, Priority, ActivityDate, Description,
               OwnerId, Owner.Name, WhoId, Who.Name, Type, TaskSubtype,
               CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
        FROM Task
        WHERE WhatId = '{opportunity_id}'
        ORDER BY ActivityDate DESC NULLS LAST
        """
        result = await salesforce.query(query)
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
            "SELECT locked_by FROM opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
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
                "SELECT locked_by FROM opportunity_lock WHERE sf_opportunity_id = $1", dest_opp
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
        return ApiResponse(success=True, data={"id": new_id, "message": "Task duplicated"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error duplicating task: {e}")
        raise HTTPException(status_code=500, detail="Failed to duplicate task")


@app.get("/api/calendar/my-events")
async def get_my_calendar_events(
    start: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    limit: int = Query(100, le=200),
    calendar_id: str = Query("primary", description="Calendar ID (default: primary)"),
    user=Depends(require_auth),
):
    """Get Google Calendar events in a date range. Supports shared calendars via calendar_id."""
    client = _services.get("mcp_client")
    cal_service = client.services.get("google_calendar") if client else None
    if not cal_service or not cal_service.is_authenticated:
        return ApiResponse(
            success=True,
            data=[],
            meta={"message": "Calendar not connected"},
        )

    try:
        from datetime import datetime as dt

        days_back = 0
        days_forward = 14
        if start:
            delta = dt.now() - dt.strptime(start, "%Y-%m-%d")
            days_back = max(0, delta.days)
        if end:
            delta = dt.strptime(end, "%Y-%m-%d") - dt.now()
            days_forward = max(1, delta.days)

        events = await cal_service.search_events(
            query="",
            days_back=days_back,
            days_forward=days_forward,
            max_results=limit,
            calendar_id=calendar_id,
        )
        return ApiResponse(success=True, data=events, meta={"count": len(events)})
    except Exception as e:
        logger.error(f"Error fetching calendar events: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
            "CloseDate, Description, Type"
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
                "Type": record.get("Type"),
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

