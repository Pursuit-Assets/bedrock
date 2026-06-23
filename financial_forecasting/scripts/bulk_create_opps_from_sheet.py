"""Bulk-create jobs opportunities from the employer-pipeline Google Sheet.

Idempotent: skips any company whose opportunity already exists (case-insensitive
account_name match). Each created opportunity is tied to its listed contact
(matched in public.contacts by name, else created as a jobs contact) via
sf_contact_ids = ['pub:<contact_id>'].

  python -m scripts.bulk_create_opps_from_sheet            # DRY RUN (prints plan)
  python -m scripts.bulk_create_opps_from_sheet --commit   # writes

Mappings (confirmed with user):
  owner   = Pursuit Lead (fallback Relationship Owner)
  stage   = blank→initial_outreach, 2 Call Scheduled/3 Opportunity Shared→
            active_in_discussions, 4 Role Confirmed→active_opportunity_confirmed,
            6 Builders Interviewing→active_builder_interview, 8 Placed→closed_won
  deal_type = Capstone(source/structure)→capstone, else ft
  likelihood = 1-High→high, 2-Med→medium, 3-Low→low
"""
import argparse
import asyncio
import os
import re
import sys

from dotenv import load_dotenv

OWNER_EMAIL = {
    "nick": "nick@pursuit.org", "avni": "avni@pursuit.org", "devika": "devika@pursuit.org",
    "damon": "damon.kornhauser@pursuit.org", "joanna": "joanna.patterson@pursuit.org",
    "andrew": "andrew@pursuit.org", "dave": "david@pursuit.org", "david": "david@pursuit.org",
    "jac": "jac@pursuit.org", "an": "an@pursuit.org", "afiya": "afiya.augustine@pursuit.org",
    "greg": "gregh@pursuit.org",
}
STATUS_STAGE = {
    "2. call scheduled": "active_in_discussions",
    "3. opportunity shared": "active_in_discussions",
    "4. role confirmed": "active_opportunity_confirmed",
    "6. builders interviewing": "active_builder_interview",
    "8. placed": "closed_won",
}
LIKELIHOOD = {"1 - high": "high", "2 - med": "medium", "3 - low": "low"}

# Rows from the sheet: (company, first, last, email, roles, structure, salary,
# rel_owner, pursuit_lead, likelihood, status, source)
ROWS = [
    ("Acture","Gabe","Stacey","",1,"20k subsidy","$80,000","Nick","Avni","1 - High","4. Role Confirmed","Fireside"),
    ("Tiger Tracks","Cliff","Simmons","",1,"46k subsidy","$86,000","Nick","Devika","1 - High","4. Role Confirmed",""),
    ("Pursuit","","","",1,"FT Hire","$85,000","Joanna","Joanna","1 - High","4. Role Confirmed",""),
    ("Brooklyn Chamber of Commerce","","","","","","","Andrew","Andrew","1 - High","",""),
    ("Apollo","Sameer","Gupta","","","","","Devika","Devika","1 - High","","Capstone"),
    ("Rodeo","Art","","Art@rodeocannabisco.com",1,"","$85,000","Nick","","1 - High","4. Role Confirmed",""),
    ("AFIMAC Global","Jonathan","Kogan","",1,"","","Damon","Damon","2 - Med","3. Opportunity Shared",""),
    ("Ronati","Jessica","Alexander","",1,"","","Damon","Damon","2 - Med","3. Opportunity Shared",""),
    ("Touchlab","Jeff","Namnum","","","","","Damon","Damon","2 - Med","3. Opportunity Shared",""),
    ("Good Samaritan","","","",1,"FT Hire","","An","Avni","2 - Med","6. Builders Interviewing",""),
    ("City Council","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("Queens Chamber","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("LaGuardia Community College","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("UFT","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("TechNYC","","","","","","","Nick","Andrew","2 - Med","",""),
    ("Jobs Council","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("PFNYC","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("Future of Higher Education Network","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("ServiceNow","","","","","","","Andrew","Andrew","2 - Med","",""),
    ("Food Education Fund","Danielle","Beam","","","","","Avni","Avni","2 - Med","","Goldman pilot"),
    ("Cypress Hills","Elaine","Mahoney","","","","","Avni","Avni","2 - Med","","Goldman pilot"),
    ("Anthos Home","Jeremy","Morse","","","","","Avni","Avni","2 - Med","","Goldman pilot"),
    ("Big Brothers Big Sisters","Natalia","Sardo","","","","","Avni","Avni","2 - Med","","Goldman pilot"),
    ("iMentor","Parice","Grant","","","","","Avni","Avni","2 - Med","","Goldman not selected"),
    ("Adonis AI","Reed","Kalash","","","","","Jac","Avni","2 - Med","","Capstone"),
    ("Kohlberg","Michael","Bogobowicz","","","","","Nick","Avni","2 - Med","","Nick network"),
    ("COOP Careers","Gordon","Lee","","","","","Avni","Avni","2 - Med","",""),
    ("First Student","Sean","McCormack","","","","","Avni","Avni","2 - Med","",""),
    ("Crux Capital","Alfred","","","","","","Nick","Avni","2 - Med","",""),
    ("Ounce","Rachel","Munsie","",1,"","","Nick","Avni","2 - Med","",""),
    ("RXR","Andrew","Min","","","","","Dave","Dave","2 - Med","","Capstone"),
    ("Assured Health Partners","","","","","","","Devika","Devika","2 - Med","",""),
    ("Tomorrow Health","Vijay","Kedar","","","","","Nick","","2 - Med","",""),
    ("Charter","","","","","","","Devika","","2 - Med","",""),
    ("Eataly","Morgan","Pruitt","",1,"","","Damon","Damon","3 - Low","2. Call Scheduled",""),
    ("Queens Community House","Kyle","Butler","","","","","Avni","Avni","3 - Low","","Goldman pilot"),
    ("Bed Stuy Restoration Corp","Blondel","Pinnock","","","","","Avni","Avni","3 - Low","","Goldman not selected"),
    ("Asian Americans for Equality","My","Chang","","","","","Avni","Avni","3 - Low","","Goldman not selected"),
    ("Enterprise","Shevani","Patel","","","","","Avni","Avni","3 - Low","",""),
    ("Vocal Media","Kiana","Kazemi","","","","","Avni","Avni","3 - Low","",""),
    ("Emerge Careers","Gabe","Saruhashi","","","","","Avni","Avni","3 - Low","",""),
    ("Fund for the City of New York","Rich","Leimsider","","","","","Avni","Avni","3 - Low","",""),
    ("Holly AI","Cherie","Chung","","","","","Avni","Avni","3 - Low","",""),
    ("Percepta AI","Hirsh","Jain","","","","","Avni","Avni","3 - Low","",""),
    ("Zero AI","Brian","Luscombe","","","","","Jac","Avni","3 - Low","","Hackathon"),
    ("Mona","Andrew Leon","Hanna","","","","","Avni","Avni","3 - Low","",""),
    ("Plastic Labs","Abigal","Spigarelli","","","","","Afiya","Avni","3 - Low","","Fireside"),
    ("Easie","Rock","Vitale","","","","","Greg","Avni","3 - Low","","Fireside"),
    ("CodeYam","Nadia","Eldeib","","","","","Avni","Avni","3 - Low","",""),
    ("Shoken","Jennifer","Geiling","","","","","Avni","Avni","3 - Low","",""),
    ("Terraton","Nat","Robinson","","","","","Avni","Avni","3 - Low","",""),
    ("Carroll Mechanical","Bryan","Bu","","","","","Avni","Avni","3 - Low","",""),
    ("mHUB","Haven","Allen","","","","","Avni","Avni","3 - Low","",""),
    ("Rayni","Divyanshu","Sharma","","","","","Avni","Avni","3 - Low","",""),
    ("Winus Packaging","David","Lee","","","","","Avni","Avni","3 - Low","",""),
    ("CBIZ Private Equity Advisory","Ethan","Yu","","","","","Avni","Avni","3 - Low","",""),
    ("17a","Annie","Rittgers","","","","","Avni","Avni","3 - Low","",""),
    ("Execute","Michael","Gaba","","","","","Avni","Avni","3 - Low","",""),
    ("Lumiere Education","Stephen","Turban","","","","","Avni","Avni","3 - Low","",""),
    ("Taproot Foundation","Cat","Ward","","","","","Avni","Avni","3 - Low","",""),
    ("All4Ed","Amy","Loyd","","","","","Avni","Avni","3 - Low","",""),
    ("Pulse Charter Connect","Laura","Epstein","","","","","Avni","Avni","3 - Low","",""),
    ("American Red Cross","Doreen","Thomann-Howe","","","","","Avni","Avni","3 - Low","",""),
    ("MineMe","Archana","Somasegar","","","","","Avni","Avni","3 - Low","",""),
    ("Hive Ownership","Christine","Curella","","","","","Avni","Avni","3 - Low","",""),
    ("Fortuna Health","Cydney","Kim","","","","","Avni","Avni","3 - Low","",""),
    ("A Healthier Democracy","Benjamin","Ruxin","","","","","Avni","Avni","3 - Low","",""),
    ("NYC Public Housing Preservation Trust","Jillian","McLaughlin","","","","","Avni","Avni","3 - Low","",""),
    ("Cartwheel","Daniel","Tartakovsky","","","","","Avni","Avni","3 - Low","",""),
    ("Echoing Green","Louisa","Cacoilo","","","","","Avni","Avni","3 - Low","",""),
    ("Good Sense & Co","Lily","Styles","","","","","Damon","Damon","3 - Low","",""),
    ("OpenRouter","Alex","Atallah","","","","","Devika","Devika","3 - Low","","board"),
    ("Citizens Bank","","","",5,"","$85,000","","","","4. Role Confirmed",""),
    ("US Chamber of Commerce","","","",1,"","$85,000","","","","4. Role Confirmed",""),
    ("Fowler","","","",1,"","$85,000","","","","8. Placed",""),
    ("JPMC","","","",3,"","$97,760","","","","8. Placed",""),
    ("Vobile","","","",1,"","$42,500","","","","8. Placed",""),
    ("CBS","","","",1,"","$63,000","","","","8. Placed",""),
    ("Multiplier","","","",1,"","$83,000","","","","8. Placed",""),
    ("ICL","","","",1,"","$51,000","","","","8. Placed",""),
    ("Big Human","","","",1,"","$105,000","","","","8. Placed",""),
]

# Confirmed-duplicate sheet companies that already exist under a variant name
# (user reviewed the fuzzy matches) — skip creating these.
SKIP_AS_DUPLICATE = {
    "acture", "cypress hills", "kohlberg", "crux capital", "assured health partners",
    "bed stuy restoration corp", "emerge careers",          # clear dupes
    "charter", "fowler", "cbs", "big brothers big sisters",  # confirmed dupes
}

# Reviewed contact decisions (keyed by company, lowercased):
#  - FORCE_LINK: attach this existing contact_id (verified same person, incl.
#    job-changers / name variants the user approved).
#  - LEAVE_CONTACT_BLANK: exists elsewhere (e.g. Salesforce only) — don't create
#    a jobs contact; leave the opp contact-less for manual linking.
FORCE_LINK_CONTACT = {
    "rodeo": 33064,                                   # Art Linares @ Rodeo
    "nyc public housing preservation trust": 17677,   # Jillian McLaughlin (name variant)
    "afimac global": 30546,                           # Jonathan Kogan (job change)
    "zero ai": 12647,                                 # Brian Luscombe (ZeroClick.ai)
    "shoken": 17664,                                  # Jennifer Geiling (job change)
    "taproot foundation": 2751,                       # Cat Ward (job change)
    "echoing green": 16975,                           # Louisa Caçoilo (accent — avoid dup)
}
LEAVE_CONTACT_BLANK = {"openrouter"}                  # Alex Atallah is in Salesforce only

# Excluded (no usable company / internal): person-only rows + ambiguous internal.
EXCLUDED = ["(Isaac Botier — no company)", "(Winston Huang — no company)",
            "(Julia Simmons — no company)", "(Miranda D. — no company)",
            "Pursuit? (internal)", "Board? (internal)", "MMoser [DY] (ambiguous)",
            "PDP [DY] (ambiguous)", "Dan Teran (person/VC, no company)",
            "GT Edge AI (contact '?')"]


def owner_email(rel, lead):
    name = (lead or rel or "").strip().lower()
    return OWNER_EMAIL.get(name)


def stage_for(status):
    s = (status or "").strip().lower()
    return STATUS_STAGE.get(s, "initial_outreach")


def deal_type_for(structure, source):
    blob = f"{structure} {source}".lower()
    return "capstone" if "capstone" in blob else "ft"


def salary_int(s):
    digits = re.sub(r"[^0-9]", "", s or "")
    return int(digits) if digits else None


async def main(commit: bool):
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    existing = {r["k"] for r in await conn.fetch(
        "SELECT lower(trim(account_name)) k FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL")}

    plan, skipped = [], []
    for (company, first, last, email, roles, structure, salary, rel, lead, likelihood, status, source) in ROWS:
        if not company.strip():
            continue
        if company.strip().lower() in existing:
            skipped.append(f"{company} (already exists)")
            continue
        if company.strip().lower() in SKIP_AS_DUPLICATE:
            skipped.append(f"{company} (dupe of existing variant)")
            continue
        plan.append({
            "company": company.strip(),
            "owner": owner_email(rel, lead),
            "owner_name": (lead or rel),
            "stage": stage_for(status),
            "deal_type": deal_type_for(structure, source),
            "likelihood": LIKELIHOOD.get((likelihood or "").strip().lower()),
            "num_roles": int(roles) if str(roles).strip().isdigit() else None,
            "salary": salary_int(salary),
            "contact": (f"{first} {last}".strip(), email.strip()),
            "source": source.strip() or None,
        })

    print(f"=== PLAN: {len(plan)} new opportunities (skipped {len(skipped)} existing) ===\n")
    for p in plan:
        cdisp = p["contact"][0] or "—"
        owner = p["owner"] or f"?? unmapped ({p['owner_name']})"
        print(f"  {p['company'][:34]:34} | {p['stage']:28} | {p['deal_type']:8} | {str(p['likelihood'] or '-'):6} | roles={p['num_roles'] or '-'} sal={p['salary'] or '-'} | owner={owner} | contact={cdisp}")
    unmapped = [p for p in plan if not p["owner"]]
    if unmapped:
        print(f"\n  !! {len(unmapped)} have NO owner mapped (blank Pursuit Lead & Relationship Owner)")
    print(f"\nExcluded (not opportunities): {', '.join(EXCLUDED)}")

    if not commit:
        print("\nDRY RUN — nothing written. Re-run with --commit to create.")
        await conn.close()
        return

    created = 0
    async with conn.transaction():
        for p in plan:
            cname, cemail = p["contact"]
            contact_id = None
            ckey = p["company"].strip().lower()
            if ckey in LEAVE_CONTACT_BLANK:
                cname = ""  # don't match or create; leave opp contact-less
            elif ckey in FORCE_LINK_CONTACT:
                contact_id = FORCE_LINK_CONTACT[ckey]
                await conn.execute("UPDATE public.contacts SET is_jobs_contact=true WHERE contact_id=$1", contact_id)
                cname = ""  # already resolved; skip matching/creation
            if cname:
                # 1) email is the strongest signal
                if cemail:
                    contact_id = await conn.fetchval(
                        "SELECT contact_id FROM public.contacts WHERE lower(email)=lower($1) LIMIT 1", cemail)
                # 2) name match — only LINK when we're confident it's the same
                #    person: company agrees, or the record has no company on file
                #    and it's the sole same-name match. Otherwise create a fresh
                #    contact rather than mislink to a same-name person elsewhere.
                if not contact_id:
                    matches = await conn.fetch(
                        "SELECT contact_id, current_company FROM public.contacts WHERE lower(trim(full_name))=lower($1)", cname)
                    co = p["company"].lower()
                    agree = [m for m in matches if m["current_company"] and (co in m["current_company"].lower() or m["current_company"].lower() in co)]
                    if len(agree) >= 1:
                        contact_id = agree[0]["contact_id"]
                    elif len(matches) == 1 and not matches[0]["current_company"]:
                        contact_id = matches[0]["contact_id"]
                if not contact_id:
                    contact_id = await conn.fetchval(
                        """INSERT INTO public.contacts (full_name, email, current_company, contact_stage, is_jobs_contact, source)
                           VALUES ($1, NULLIF($2,''), $3, 'lead', true, 'sheet_import') RETURNING contact_id""",
                        cname, cemail, p["company"])
                else:
                    await conn.execute("UPDATE public.contacts SET is_jobs_contact=true WHERE contact_id=$1", contact_id)
            sf_ids = [f"pub:{contact_id}"] if contact_id else []
            await conn.execute(
                """INSERT INTO bedrock.jobs_opportunity
                       (account_id, account_name, stage, deal_type, owner_email, likelihood,
                        num_roles, salary_expected, sf_contact_ids, source)
                   VALUES ('UNKNOWN', $1, $2, $3, $4, $5, $6, $7, $8, $9)""",
                p["company"], p["stage"], p["deal_type"], p["owner"], p["likelihood"],
                p["num_roles"], p["salary"], sf_ids, p["source"] or "sheet_import")
            created += 1
    print(f"\nCREATED {created} opportunities (+ linked/created contacts).")
    await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    load_dotenv()
    asyncio.run(main(args.commit))
