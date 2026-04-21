"""Salesforce schema describe endpoint — audit tool for field discovery.

Calls the Salesforce Opportunity describe() API and returns a slim field list.
Use ?compare=true to see which fields are currently fetched in the SOQL query.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth_or_internal
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/salesforce", tags=["salesforce-schema"])

# Snapshot of fields currently fetched in the Opportunity SOQL query (main.py:292-303).
# This is an audit reference — intentionally not imported from main.py.
OPPORTUNITY_FETCHED_FIELDS = {
    "Id", "AccountId", "Account.Name", "Name", "StageName", "Amount", "Probability",
    "CloseDate", "ForecastCategory", "LeadSource", "NextStep",
    "Description", "Type", "OwnerId", "Owner.Name", "CreatedDate", "LastModifiedDate",
    "LastActivityDate", "RenewalRepeat__c",
    "npe01__Payments_Made__c", "Outstanding_Payments__c",
    "Number_of_Payments_Received__c", "Most_Recent_Payment_Date__c",
    "Last_Actual_Payment__c", "npe01__Number_of_Payments__c",
    "PaymentDate__c", "Earliest_Scheduled_Payment__c",
    "RecordTypeId", "RecordType.Name", "Active_Opportunity__c",
    "Payment_Terms__c", "Contract_Start_Date__c", "Contract_End_Date__c",
    "Billing_Frequency__c", "ExpectedRevenue",
    "npe01__Amount_Outstanding__c", "npe01__Amount_Written_Off__c",
    "npsp__Next_Grant_Deadline_Due_Date__c", "Application_Due_Date__c",
    "Total_Risk_Adjusted_Projection__c", "Amount_Due_to_Date__c",
    "Account_Owner__c",
    "CampaignId", "Campaign.Name",
}

ACCOUNT_FETCHED_FIELDS = {
    "Id", "Name", "Type", "Industry", "Phone", "Fax", "Website", "Description",
    "BillingStreet", "BillingCity", "BillingState", "BillingPostalCode", "BillingCountry",
    "AnnualRevenue", "NumberOfEmployees", "AccountSource", "OwnerId", "Owner.Name",
    "ParentId", "RecordTypeId", "RecordType.Name",
    "CreatedDate", "LastModifiedDate", "LastActivityDate",
    "Account_Tier__c", "Active__c", "Company_Size__c",
    "npsp__Grantmaker__c", "npsp__Funding_Focus__c",
    "Philanthropy__c", "Fee_For_Service__c", "Hiring__c", "Investment__c",
    "Volunteering__c", "Fellow_Recruitment__c", "Media_Marketing__c",
    "Influence__c", "Startup__c", "Organization_Focus_Area_s__c",
    "npo02__TotalOppAmount__c", "npo02__NumberOfClosedOpps__c",
    "npo02__AverageAmount__c", "npo02__LargestAmount__c", "npo02__SmallestAmount__c",
    "npo02__FirstCloseDate__c", "npo02__LastCloseDate__c",
    "npo02__OppAmountThisYear__c", "npo02__OppAmountLastYear__c",
    "npo02__Best_Gift_Year__c", "npo02__Best_Gift_Year_Total__c",
    "npsp__Matching_Gift_Company__c", "npsp__Matching_Gift_Percent__c",
    "npsp__Matching_Gift_Amount_Max__c", "npsp__Matching_Gift_Amount_Min__c",
    "npsp__Matching_Gift_Annual_Employee_Max__c",
    "npsp__Matching_Gift_Administrator_Name__c", "npsp__Matching_Gift_Email__c",
    "npsp__Matching_Gift_Phone__c", "npsp__Matching_Gift_Comments__c",
    "npsp__Matching_Gift_Info_Updated__c", "npsp__Matching_Gift_Request_Deadline__c",
    "Total_Revenue_Generated__c",
    "Last_Activity_Date__c", "Date_of_First_Pursuit_Hire__c",
}

CONTACT_FETCHED_FIELDS = {
    "Id", "AccountId", "Account.Name", "FirstName", "LastName", "Name",
    "Salutation", "Title", "Department", "Email", "Phone", "MobilePhone",
    "MailingStreet", "MailingCity", "MailingState", "MailingPostalCode", "MailingCountry",
    "OwnerId", "Owner.Name", "LeadSource", "Birthdate", "Description",
    "DoNotCall", "HasOptedOutOfEmail", "RecordTypeId", "RecordType.Name",
    "CreatedDate", "LastModifiedDate", "LastActivityDate",
    "npsp__Primary_Affiliation__c", "npsp__Primary_Affiliation__r.Name",
    "npsp__Deceased__c", "npsp__Do_Not_Contact__c",
    "npe01__WorkEmail__c", "npe01__HomeEmail__c", "npe01__AlternateEmail__c",
    "npe01__WorkPhone__c", "npe01__PreferredPhone__c", "npe01__Preferred_Email__c",
    "npe01__Primary_Address_Type__c",
    "Preferred_Name__c", "Pronouns__c", "Gender__c", "LinkedIn_URL__c",
    "Philanthropic_Contact__c", "Philanthropy__c", "Board_Status__c",
    "Volunteer__c", "Added_to_Slack__c", "Last_Touchpoint__c",
    "Last_Activity_Date__c", "Days_Since_Last_Activity__c",
    "Primary_Affiliation_Entity__c", "Primary_Affiliation_Name__c",
    "GW_Volunteers__Volunteer_Hours__c", "GW_Volunteers__Last_Volunteer_Date__c",
}

PAYMENT_FETCHED_FIELDS = {
    "Id", "Name", "npe01__Opportunity__c", "npe01__Opportunity__r.Name",
    "npe01__Opportunity__r.Account.Name",
    "npe01__Payment_Amount__c", "npe01__Scheduled_Date__c",
    "npe01__Payment_Date__c", "npe01__Paid__c",
    "npe01__Payment_Method__c", "npe01__Check_Reference_Number__c",
    "npe01__Written_Off__c", "Write_off_reason__c",
    "Amount_Received__c", "Department__c", "GL_Account__c",
    "GL_Payment_Received__c", "Reconciled_with_Finance__c",
    "Batch_Name__c", "Payment_Estimate__c", "Invoice__c",
    "Affiliation__c", "CreatedDate", "LastModifiedDate",
    "Payment_Status__c", "Delinquent__c", "Paid_Status__c",
    "Amount_Formula__c", "Amount_Minus_Received__c",
}


def _slim_field(field: Dict[str, Any], fetched_set: Optional[set]) -> Dict[str, Any]:
    """Extract the useful subset of a Salesforce field describe result."""
    slim: Dict[str, Any] = {
        "name": field.get("name"),
        "label": field.get("label"),
        "type": field.get("type"),
        "custom": field.get("custom", False),
        "updateable": field.get("updateable", False),
        "calculated": field.get("calculated", False),
        "nillable": field.get("nillable", False),
        "defaultValue": field.get("defaultValue"),
    }
    # Include reference metadata for lookup fields
    if field.get("type") == "reference":
        slim["referenceTo"] = field.get("referenceTo", [])
        slim["relationshipName"] = field.get("relationshipName")
    # Include picklist values for picklist/multipicklist fields
    if field.get("type") in ("picklist", "multipicklist"):
        slim["picklistValues"] = [
            {
                "value": pv.get("value"),
                "label": pv.get("label"),
                "active": pv.get("active", True),
            }
            for pv in field.get("picklistValues", [])
        ]
    if fetched_set is not None:
        slim["fetched"] = field.get("name") in fetched_set
    return slim


# Map of sobject -> fetched fields for the compare feature
_FETCHED_FIELDS_BY_SOBJECT: Dict[str, set] = {
    "Opportunity": OPPORTUNITY_FETCHED_FIELDS,
    "Account": ACCOUNT_FETCHED_FIELDS,
    "Contact": CONTACT_FETCHED_FIELDS,
    "npe01__OppPayment__c": PAYMENT_FETCHED_FIELDS,
}


@router.get("/schema/{sobject}")
async def describe_sobject(
    sobject: str,
    compare: bool = Query(False, description="Compare against currently fetched fields"),
    custom_only: bool = Query(False, description="Only return custom fields"),
    client: UnifiedMCPClient = Depends(get_mcp_client),
    user=Depends(require_auth_or_internal),
):
    """Describe a Salesforce SObject — returns field metadata for schema auditing."""
    try:
        salesforce = client.salesforce
        result = await salesforce.describe_sobject(sobject)

        fields_raw: List[Dict[str, Any]] = result.get("fields", [])
        fetched_set = _FETCHED_FIELDS_BY_SOBJECT.get(sobject) if compare else None

        fields = [
            _slim_field(f, fetched_set)
            for f in fields_raw
            if not custom_only or f.get("custom", False)
        ]

        # Record Types — SF's describe() response includes `recordTypeInfos`
        # alongside fields. Expose the active ones so the frontend can render a
        # RecordType picklist without a second network call. See BUG-UI-9.
        record_types_raw: List[Dict[str, Any]] = result.get("recordTypeInfos", []) or []
        record_types = [
            {
                "id": rt.get("recordTypeId"),
                "name": rt.get("name"),
                "developerName": rt.get("developerName"),
                "available": rt.get("available", True),
                "defaultRecordTypeMapping": rt.get("defaultRecordTypeMapping", False),
                "master": rt.get("master", False),
            }
            for rt in record_types_raw
            # Exclude the Master record type (always present, never user-facing)
            if not rt.get("master", False)
        ]

        response: Dict[str, Any] = {
            "sobject": sobject,
            "totalFields": len(fields_raw),
            "returnedFields": len(fields),
            "fields": fields,
            "recordTypes": record_types,
        }

        if compare and fetched_set is not None:
            response["currentlyFetched"] = sorted(fetched_set)
            response["notFetched"] = sorted(
                f["name"] for f in fields if not f.get("fetched", True)
            )

        return response

    except Exception as e:
        logger.error(f"Error describing {sobject}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to describe {sobject}: {e}")
