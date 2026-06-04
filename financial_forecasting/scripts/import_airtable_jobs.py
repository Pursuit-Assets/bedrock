"""One-time import of Airtable Jobs pipeline into bedrock.jobs_opportunity.

Maps:
  Job Deals   → bedrock.jobs_opportunity
  Emp. Engagements → bedrock.activity (with jobs_opportunity_id)

Run once after applying the migration:
  python3 scripts/import_airtable_jobs.py
"""

import asyncio
import httpx
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from dotenv import load_dotenv
load_dotenv()

import asyncpg
from simple_salesforce import Salesforce

BASE_ID = "appU97D9wOfq6eidF"
DEALS_TABLE = "tbllNUHlb11IaW0S6"
ENGAGEMENTS_TABLE = "tblRcbb5SzvuWBCCh"
COMPANIES_TABLE = "tblOyUDqF6kcntIYk"

STAGE_MAP = {
    "R+D (pre-contact)":            "lead_submitted",
    "Reached Out":                   "initial_outreach",
    "In Discussion":                 "active_in_discussions",
    "In Contract":                   "active_in_discussions",
    "Active: Builder Matching":      "active_opportunity_confirmed",
    "Active: Builder Interviews":    "active_builder_interview",
    "Candidates Submitted":          "active_builder_interview",
    "Interviewing":                  "active_builder_interview",
    "Closed - Won/FTE":              "closed_won",
    "Closed - Won/Contract":         "closed_won",
    "Closed - Won/Capstone or Volunteer": "closed_won",
    "Closed - Lost":                 "closed_lost",
}

DEAL_TYPE_MAP = {
    "Closed - Won/FTE":              "ft",
    "Closed - Won/Contract":         "pt_contract",
    "Closed - Won/Capstone or Volunteer": "capstone",
    "Job: Existing FTE":             "ft",
    "Job: New FTE":                  "ft",
    "Job: PT/Contract":              "pt_contract",
    "Workshop":                      "workshop",
    "Capstone":                      "capstone",
    "Pilot":                         "pilot",
}

OUTREACH_TYPE_MAP = {
    "Email":    "email",
    "Call":     "call",
    "Meeting":  "meeting",
    "LinkedIn": "email",
    "Text":     "email",
}


def _at_headers():
    return {"Authorization": f"Bearer {os.environ['AIRTABLE_PAT']}"}


async def _fetch_all(client, table_id, fields=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table_id}"
    params = {"pageSize": 100}
    if fields:
        params["fields[]"] = fields
    records = []
    while True:
        r = await client.get(url, params=params, headers=_at_headers())
        data = r.json()
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        params["offset"] = offset
    return records


def _sf_lookup_account(sf, company_name: str) -> tuple[str | None, str | None]:
    if not company_name:
        return None, None
    safe = company_name.replace("'", "\\'")
    try:
        result = sf.query(
            f"SELECT Id, Name FROM Account WHERE Name LIKE '%{safe[:40]}%' LIMIT 1"
        )
        recs = result.get("records", [])
        if recs:
            return recs[0]["Id"], recs[0]["Name"]
    except Exception as e:
        print(f"  SF lookup failed for '{company_name}': {e}")
    return None, company_name


async def _db_lookup_account(conn, company_name: str, website: str = "") -> tuple[str | None, str | None]:
    """Match company to SF account via domain mapping or name match."""
    # Try domain from website first
    if website:
        domain = website.lower().replace("https://", "").replace("http://", "").replace("www.", "").rstrip("/").split("/")[0]
        row = await conn.fetchrow(
            "SELECT sf_account_id FROM bedrock.account_email_domain WHERE domain=$1", domain
        )
        if row:
            return row["sf_account_id"], company_name

    # Name match via public.companies domain → account_email_domain
    if company_name:
        row = await conn.fetchrow(
            """
            SELECT aed.sf_account_id
            FROM public.companies c
            JOIN bedrock.account_email_domain aed ON aed.domain = c.domain
            WHERE lower(c.name) = lower($1)
               OR lower(c.name) LIKE lower($1) || '%'
            LIMIT 1
            """,
            company_name,
        )
        if row:
            return row["sf_account_id"], company_name

    return None, company_name


async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])

    async with httpx.AsyncClient(timeout=30) as client:
        print("Fetching Airtable tables...")
        deals = await _fetch_all(client, DEALS_TABLE)
        engagements = await _fetch_all(client, ENGAGEMENTS_TABLE)
        companies = await _fetch_all(client, COMPANIES_TABLE)

    print(f"  {len(deals)} deals, {len(engagements)} engagements, {len(companies)} companies")

    # Build company lookup: airtable record ID → {name, website}
    company_lookup = {
        r["id"]: {
            "name": r["fields"].get("Company Name", ""),
            "website": r["fields"].get("Website", ""),
        }
        for r in companies
    }
    company_names = {k: v["name"] for k, v in company_lookup.items()}

    # Import deals
    deal_id_map = {}  # airtable ID → bedrock UUID
    imported = 0
    skipped = 0

    print("\nImporting Job Deals...")
    for deal in deals:
        f = deal["fields"]
        at_id = deal["id"]
        at_stage = f.get("Deal Stage", "")
        stage = STAGE_MAP.get(at_stage, "lead_submitted")

        # Derive deal_type: from stage first, then from Deal Type field
        deal_type = DEAL_TYPE_MAP.get(at_stage)
        for dt in f.get("Deal Type", []):
            if dt in DEAL_TYPE_MAP and not deal_type:
                deal_type = DEAL_TYPE_MAP[dt]

        # Resolve company → SF Account
        company_refs = f.get("Company", [])
        company_info = company_lookup.get(company_refs[0], {}) if company_refs else {}
        company_name = company_info.get("name", "")
        website = company_info.get("website", "")
        sf_account_id, sf_account_name = await _db_lookup_account(conn, company_name, website)

        # Owner: Pursuit Deal Lead is a linked record, we'll store as text for now
        owner_refs = f.get("Pursuit Deal Lead", [])

        builders = f.get("Builders", "")
        def _parse_ts(s):
            if not s:
                return None
            try:
                return datetime.fromisoformat(s.replace("Z", "+00:00"))
            except Exception:
                return None

        created_ts = _parse_ts(f.get("Created"))
        closed_at = created_ts if stage in ("closed_won", "closed_lost") else None

        row_id = await conn.fetchval(
            """
            INSERT INTO bedrock.jobs_opportunity (
                account_id, account_name, stage, deal_type,
                builder_ids, sf_opportunity_id,
                airtable_id, created_at, closed_at
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6,
                $7, COALESCE($8, now()), $9
            )
            ON CONFLICT (airtable_id) DO UPDATE SET
                stage        = EXCLUDED.stage,
                deal_type    = EXCLUDED.deal_type,
                account_id   = EXCLUDED.account_id,
                account_name = EXCLUDED.account_name,
                updated_at   = now()
            RETURNING id
            """,
            sf_account_id or "UNKNOWN",
            sf_account_name or company_name,
            stage,
            deal_type,
            [builders] if builders else [],
            None,
            at_id,
            created_ts,
            closed_at,
        )
        deal_id_map[at_id] = row_id
        print(f"  ✓ {sf_account_name or company_name} | {at_stage} → {stage} | type={deal_type}")
        imported += 1

    print(f"\n{imported} deals imported, {skipped} skipped")

    # Import Emp. Engagements → bedrock.activity
    print("\nImporting Emp. Engagements as activity...")
    act_imported = 0

    for eng in engagements:
        f = eng["fields"]
        at_id = eng["id"]

        date_str = f.get("Date of Contact")
        if not date_str:
            continue
        try:
            activity_date = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except Exception:
            continue

        outreach_type = f.get("Outreach Type", "")
        activity_type = OUTREACH_TYPE_MAP.get(outreach_type, "email")

        summary = f.get("Summary", "")
        next_steps = f.get("Next Steps", "")
        description = summary
        if next_steps:
            description += f"\n\nNext Steps: {next_steps}"

        # Link to deal
        deal_refs = f.get("Job Deals", [])
        jobs_opp_id = None
        if deal_refs:
            jobs_opp_id = deal_id_map.get(deal_refs[0])

        # Company from linked deal
        company_refs = f.get("Company", [])
        company_name = company_names.get(company_refs[0], "") if company_refs else ""
        sf_account_id = None
        if jobs_opp_id:
            row = await conn.fetchrow(
                "SELECT account_id FROM bedrock.jobs_opportunity WHERE id=$1", jobs_opp_id
            )
            if row and row["account_id"] != "UNKNOWN":
                sf_account_id = row["account_id"]

        try:
            await conn.execute(
                """
                INSERT INTO bedrock.activity (
                    type, subject, description, activity_date,
                    source, account_id, logged_by,
                    jobs_opportunity_id
                ) VALUES (
                    $1, $2, $3, $4,
                    'manual', $5, $6,
                    $7
                )
                ON CONFLICT DO NOTHING
                """,
                activity_type,
                f"Outreach: {company_name}" if company_name else "Employer Engagement",
                description,
                activity_date,
                sf_account_id,
                None,
                jobs_opp_id,
            )
            act_imported += 1
        except Exception as e:
            print(f"  engagement import failed: {e}")

    print(f"{act_imported} engagements imported as activity rows")

    # Summary
    stage_counts = await conn.fetch(
        "SELECT stage, count(*) FROM bedrock.jobs_opportunity GROUP BY stage ORDER BY count(*) DESC"
    )
    print("\nPipeline summary:")
    for r in stage_counts:
        print(f"  {r['stage']:<35} {r['count']}")

    await conn.close()


asyncio.run(main())
