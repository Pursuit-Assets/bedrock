"""Patch gaps in imported jobs data:
1. Resolve Pursuit Staff IDs → owner_email on jobs_opportunity
2. Resolve Outreach Owner IDs → logged_by on activity
3. Fetch employer Contacts → sf_contact_ids on jobs_opportunity
4. Fetch Builders → builder_ids on jobs_opportunity
"""
import asyncio, os, sys, httpx
sys.path.insert(0, '/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting')
from dotenv import load_dotenv
load_dotenv('/Users/jacquelinereverand/dev/build/bedrock/financial_forecasting/.env')
import asyncpg

BASE_ID = "appU97D9wOfq6eidF"
DEALS_TABLE    = "tbllNUHlb11IaW0S6"
ENGAGEMENTS_TABLE = "tblRcbb5SzvuWBCCh"
STAFF_TABLE    = "tblnQGOiB76J6XJHy"
CONTACTS_TABLE = "tbl6pBGyaYPevqL4D"
BUILDERS_TABLE = "tblY5eDf1tNKoVeBi"

# Known name → email mapping for Pursuit staff
STAFF_EMAIL_MAP = {
    "Avni N.":          "avni@pursuit.org",
    "Avni Nair":        "avni@pursuit.org",
    "Damon Kornhauser": "damon.kornhauser@pursuit.org",
    "Damon":            "damon.kornhauser@pursuit.org",
    "Devika":           "devika@pursuit.org",
    "David Yang":       "david@pursuit.org",
    "Greg Hogue":       "gregh@pursuit.org",
    "Andrew Tein":      "andrew@pursuit.org",
    "Jac Reverand":     "jac@pursuit.org",
    "Nick Simmons":     "nick@pursuit.org",
    "Becky Lee":        "becky@pursuit.org",
    "Timothy Asprec":   "timothyasprec@pursuit.org",
    "Victoria Mayo":    "victorialiu@pursuit.org",
    "Stefano Barros":   "stef@pursuit.org",
    "Laura Capucilli":  "laura@pursuit.org",
    "Erica W.":         "ericawong@pursuit.org",
    "Erica Wong":       "ericawong@pursuit.org",
    "Guilherme Barros": "guilherme@pursuit.org",
    "Jp Bowditch":      "jp@pursuit.org",
    "Joanna Patterson": "joanna@pursuit.org",
    "Devika Gopal agge":"devika@pursuit.org",
    "Devika Gopal":     "devika@pursuit.org",
    "Frances Steele":   "stef@pursuit.org",
    "Yong Kang":        "yong@pursuit.org",
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

async def main():
    conn = await asyncpg.connect(os.environ['DATABASE_URL'])

    async with httpx.AsyncClient(timeout=30) as client:
        print("Fetching Airtable data...")
        staff_recs   = await _fetch_all(client, STAFF_TABLE)
        contact_recs = await _fetch_all(client, CONTACTS_TABLE,
                           ["First Name", "Last Name", "Email", "Title", "Company"])
        builder_recs = await _fetch_all(client, BUILDERS_TABLE,
                           ["First Name", "Last Name", "Email", "Cohort"])
        deals        = await _fetch_all(client, DEALS_TABLE)
        engagements  = await _fetch_all(client, ENGAGEMENTS_TABLE)

    # Build staff ID → email map
    staff_id_map = {}
    for r in staff_recs:
        name = r["fields"].get("Name", "")
        email = STAFF_EMAIL_MAP.get(name)
        if email:
            staff_id_map[r["id"]] = email
        else:
            print(f"  ⚠ unknown staff: {name} ({r['id']})")

    print(f"\nResolved {len(staff_id_map)} staff IDs")

    # Build contact ID → {email, name, title}
    contact_id_map = {}
    for r in contact_recs:
        f = r["fields"]
        name = f"{f.get('First Name','')} {f.get('Last Name','')}".strip()
        contact_id_map[r["id"]] = {
            "name":  name,
            "email": f.get("Email", ""),
            "title": f.get("Title", ""),
        }
    print(f"Loaded {len(contact_id_map)} employer contacts")

    # Build builder ID → email
    builder_id_map = {}
    for r in builder_recs:
        f = r["fields"]
        email = f.get("Email", "")
        if email:
            builder_id_map[r["id"]] = email
    print(f"Loaded {len(builder_id_map)} builders with emails")

    # ── 1. Patch owner_email on jobs_opportunity ──────────────────────
    print("\n── Patching deal owners ──")
    owner_updated = 0
    for deal in deals:
        f = deal["fields"]
        at_id = deal["id"]
        lead_refs = f.get("Pursuit Deal Lead", [])
        if not lead_refs:
            continue
        owner_email = staff_id_map.get(lead_refs[0])
        if not owner_email:
            continue
        result = await conn.execute(
            "UPDATE bedrock.jobs_opportunity SET owner_email=$1 WHERE airtable_id=$2 AND (owner_email IS NULL OR owner_email='')",
            owner_email, at_id
        )
        if result != "UPDATE 0":
            owner_updated += 1
    print(f"  Updated owner_email on {owner_updated} deals")

    # ── 2. Patch logged_by on activity (engagement rows) ─────────────
    print("\n── Patching engagement owners ──")
    logged_updated = 0
    for eng in engagements:
        f = eng["fields"]
        owner_refs = f.get("Outreach Owner", [])
        if not owner_refs:
            continue
        logged_by = staff_id_map.get(owner_refs[0])
        if not logged_by:
            continue
        # Match by subject + date (best we can do without AT ID on activity)
        date_str = f.get("Date of Contact", "")
        if not date_str:
            continue
        company_refs = f.get("Company", [])
        summary = f.get("Summary", "")[:50]
        result = await conn.execute(
            """
            UPDATE bedrock.activity
            SET logged_by = $1
            WHERE logged_by IS NULL
              AND source = 'manual'
              AND jobs_opportunity_id IS NOT NULL
              AND activity_date::date = $2::text::date
              AND description LIKE $3
            """,
            logged_by,
            date_str,
            f"{summary}%",
        )
        if result != "UPDATE 0":
            logged_updated += 1
    print(f"  Updated logged_by on {logged_updated} activity rows")

    # ── 3. Patch sf_contact_ids + contact names on deals ─────────────
    print("\n── Patching employer contacts ──")
    contacts_updated = 0
    for deal in deals:
        f = deal["fields"]
        at_id = deal["id"]
        contact_refs = f.get("Deal Co' Contact", [])
        if not contact_refs:
            continue

        # Resolve to names/emails; try to find in public.contacts
        contact_details = [contact_id_map.get(ref, {}) for ref in contact_refs]
        sf_ids = []

        for detail in contact_details:
            email = detail.get("email", "")
            name  = detail.get("name",  "")
            if email:
                # Look up SF contact ID via public.contacts → sf_contact_link
                row = await conn.fetchrow(
                    """
                    SELECT scl.sf_contact_id
                    FROM public.contacts c
                    JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
                    WHERE lower(c.email) = lower($1)
                    LIMIT 1
                    """,
                    email,
                )
                if row:
                    sf_ids.append(row["sf_contact_id"])

        if sf_ids:
            await conn.execute(
                "UPDATE bedrock.jobs_opportunity SET sf_contact_ids=$1 WHERE airtable_id=$2",
                sf_ids, at_id
            )
            contacts_updated += 1
            print(f"  ✓ {f.get('Deal ID','?')[:40]} → {len(sf_ids)} SF contacts")
        else:
            # Store contact names as free text in description if no SF match
            names = [d.get("name", "") for d in contact_details if d.get("name")]
            if names:
                await conn.execute(
                    """
                    UPDATE bedrock.jobs_opportunity
                    SET description = CASE WHEN description IS NULL OR description=''
                        THEN $1
                        ELSE description || E'\n' || $1
                    END
                    WHERE airtable_id=$2 AND NOT ($1 = ANY(COALESCE(sf_contact_ids::text[], '{}')))
                    """,
                    f"Employer contact(s): {', '.join(names)}",
                    at_id,
                )
                print(f"  ⚠ {f.get('Deal ID','?')[:40]} → no SF match, stored name(s): {names}")

    print(f"\n  SF contacts linked: {contacts_updated} deals")

    # ── 4. Patch builder_ids on deals ─────────────────────────────────
    print("\n── Patching builder matches ──")
    builders_updated = 0
    for deal in deals:
        f = deal["fields"]
        at_id = deal["id"]
        builder_refs = f.get("Builder Matches", [])
        if not builder_refs:
            continue
        emails = [builder_id_map.get(ref) for ref in builder_refs if builder_id_map.get(ref)]
        if emails:
            # Look up org_user IDs or just store emails for now
            await conn.execute(
                "UPDATE bedrock.jobs_opportunity SET builder_ids=$1 WHERE airtable_id=$2",
                emails, at_id
            )
            builders_updated += 1
            print(f"  ✓ {f.get('Deal ID','?')[:40]} → {len(emails)} builders")

    print(f"\n  Builder matches linked: {builders_updated} deals")

    # ── Summary ────────────────────────────────────────────────────────
    print("\n── Final pipeline state ──")
    rows = await conn.fetch("""
        SELECT account_name, stage, deal_type, owner_email,
               array_length(sf_contact_ids,1) as contacts,
               array_length(builder_ids,1) as builders
        FROM bedrock.jobs_opportunity
        ORDER BY stage, account_name
    """)
    for r in rows:
        print(f"  {r['account_name']:<35} {r['stage']:<30} owner={r['owner_email'] or '?'} contacts={r['contacts'] or 0} builders={r['builders'] or 0}")

    await conn.close()

asyncio.run(main())
