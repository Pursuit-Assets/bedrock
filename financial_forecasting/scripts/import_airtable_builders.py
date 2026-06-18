"""One-time import of the Airtable "Builders" table into bedrock.builder_job_profile.

Stores ONLY the Airtable-origin job-search/coach fields. Identity, applications,
placements, intake-quiz, etc. are read from the platform DB at query time — not
imported here.

Matching: builders are resolved to a platform user_id via bedrock.l3_builders()
(SECURITY DEFINER, so the bedrock_user API role can see RLS-protected users) —
by email first, then by exact first+last name. Ambiguous / unmatched rows are
logged and skipped (user_id is the PK; we never fabricate one).

Idempotent: UPSERT keyed on user_id. Safe to re-run.

  python3 scripts/import_airtable_builders.py
"""

import asyncio
import json
import os
import sys

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from dotenv import load_dotenv
load_dotenv()

import asyncpg

BASE_ID = "appU97D9wOfq6eidF"
BUILDERS_TABLE = "Builders"


def _at_headers():
    return {"Authorization": f"Bearer {os.environ['AIRTABLE_PAT']}"}


async def _fetch_all(client, table):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table}"
    params = {"pageSize": 100}
    records, off = [], None
    while True:
        if off:
            params["offset"] = off
        r = await client.get(url, params=params, headers=_at_headers())
        r.raise_for_status()
        data = r.json()
        records.extend(data.get("records", []))
        off = data.get("offset")
        if not off:
            break
    return records


# ── coercion helpers ─────────────────────────────────────────────────────────
def _txt(v):
    if v is None:
        return None
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v) if v else None
    return str(v).strip() or None if v is not None else None


def _arr(v):
    if not v:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    # multilineText → split on newlines
    return [s.strip() for s in str(v).splitlines() if s.strip()]


def _bool(v):
    if isinstance(v, bool):
        return v
    if v is None:
        return None
    return str(v).strip().lower() in ("yes", "true", "1", "checked", "✅")


def _int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


# Airtable field → builder_job_profile column (typed). Everything else → intake.
COL_TEXT = {
    "Pursuit Coach": "pursuit_coach",
    "Gen. Notes": "gen_notes",
    "Stef Notes": "coach_notes",
    "Resume (Dec 2025)": "resume_url",
    "Lookbook Link": "lookbook_url",
    "University": "university",
    "Degree": "degree",
    "Technical Capability (Tech-First Problem Solving)": "technical_capability",
    "AI Reasoning, Troubleshooting & Autonomous Collaboration": "ai_reasoning",
    "Problem Solving (Design Thinking & Solution Framing)": "problem_solving",
    "Presentation & Technical Storytelling": "presentation",
    "Professional Behaviors & Job Search Engagement": "professional_behaviors",
    "Prof. Strength": "prof_strength",
    "Technical Strength": "technical_strength",
}
COL_ARR = {
    "Stef Flags": "coach_flags",
    "(Stef) Improvement Tags": "improvement_tags",
    "Target Industries": "target_industries",
    "Preferred Modes": "preferred_modes",
    "Certifications": "certifications",
    "Languages Spoken": "languages",
}
# Readiness checkboxes — NOT NULL, default False when the box is unchecked/absent.
COL_CHECK = {
    "Lookbook ✅": "ready_lookbook",
    "LinkedIn ✅": "ready_linkedin",
    "GitHub ✅": "ready_github",
    "CV (generic) ✅": "ready_cv",
    "Mock Interview ✅": "ready_mock",
}
# Tri-state cadence flags (Yes / No / unset) — nullable.
COL_TRIBOOL = {
    "Applying to Jobs Regularly?": "applying_regularly",
    "Networking Regularly?": "networking_regularly",
}
# Airtable field → intake JSONB key (long-tail survey + reference fields)
INTAKE_MAP = {
    "Annual salary expectation": "salary_expectation",
    "Work preferences (in-person/hybrid/remote)": "work_preference",
    "Geographic preferences": "geo_preference",
    "# of portfolio projects ready for job applications": "portfolio_projects_count",
    "What matters most in next role (top 2)": "what_matters_most",
    "Open to freelance/contract work?": "open_to_freelance",
    "Biggest employment blockers": "biggest_blockers",
    "Confidence that Pursuit can help you reach goals": "confidence",
    "What would increase your confidence in Pursuit?": "what_would_increase_confidence",
    "Years of professional experience (before Pursuit)": "years_professional_experience",
    "Years of career-aligned work experience": "years_career_aligned",
    "How close to being job-ready?": "how_close_job_ready",
    "What's missing, if you know?": "whats_missing",
    "Which best describes you right now?": "which_describes_you",
    "Which profiles/docs NOT ready to share with employers?": "profiles_not_ready",
    "Completed mock interviews with Pursuit?": "completed_mock_interviews",
    "Strongest proof of your skills right now": "strongest_proof",
    "Roles/responsibilities most interested in": "roles_interested",
    "Business departments interested in": "business_departments",
    "What specifically feels hardest right now?": "what_hardest",
    "Technical Skill Excellence": "technical_skill_excellence",
    "Business skill Excellence": "business_skill_excellence",
    "LinkedIn To-Dos": "linkedin_todos",
    "Lookbook To-Do": "lookbook_todo",
    "Submitted At": "intake_submitted_at",
    "Job Search Status": "airtable_job_search_status",  # reference only; status is auto-derived
    "LinkedIn URL": "linkedin_url",                      # fallback (platform user_profiles is sparse)
}


# Manual aliases for Airtable name variants (nickname / middle name / parenthetical)
# that don't exactly match the platform full_name. Keyed by normalized Airtable name.
NAME_ALIASES = {
    "valery rene": 87,            # → Val Rene
    "isaiah johnson": 65,         # → Isaiah Gabreil Johnson
    "jennifer poueymirou": 94,    # → Jen Poueymirou
    "fuhua (anthony) ruan": 39,   # → Fuhua Ruan
}


def _norm(s):
    return " ".join((s or "").strip().lower().split())  # collapse whitespace runs


async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], timeout=60)

    # Build email/name → user_id maps from the L3 population (RLS-bypassing fn)
    l3 = await conn.fetch("SELECT user_id, full_name, email FROM bedrock.l3_builders()")
    email_map, name_map = {}, {}
    for r in l3:
        if r["email"]:
            email_map[r["email"].strip().lower()] = r["user_id"]
        if r["full_name"]:
            name_map.setdefault(_norm(r["full_name"]), []).append(r["user_id"])

    async with httpx.AsyncClient(timeout=30) as client:
        recs = await _fetch_all(client, BUILDERS_TABLE)

    counts = {"email": 0, "name": 0, "ambiguous": 0, "unmatched": 0, "upserted": 0}
    seen_uids = {}

    for rec in recs:
        f = rec["fields"]
        airtable_id = rec["id"]
        first = (f.get("First Name") or "").strip()
        last = (f.get("Last Name") or "").strip()
        email = (f.get("Email") or "").strip().lower()
        full = _norm(f.get("Full Name") or f"{first} {last}")

        uid, match = None, "unmatched"
        if email and email in email_map:
            uid, match = email_map[email], "email"
        elif full and full in name_map:
            if len(name_map[full]) == 1:
                uid, match = name_map[full][0], "name"
            else:
                match = "ambiguous"
                print(f"  AMBIGUOUS name '{full}' → user_ids {name_map[full]} (skipped)")
        elif full in NAME_ALIASES:
            uid, match = NAME_ALIASES[full], "name"
        counts[match] += 1
        if uid is None:
            if match == "unmatched":
                print(f"  UNMATCHED: {first} {last} <{email or 'no-email'}> (skipped)")
            continue
        if uid in seen_uids:
            print(f"  DEDUP: user_id {uid} already imported from {seen_uids[uid]}; merging {airtable_id}")
        seen_uids[uid] = airtable_id

        # build typed columns
        cols = {"user_id": uid, "airtable_id": airtable_id, "import_match": match,
                "graduation_year": _int(f.get("Graduation Year"))}
        for af, col in COL_TEXT.items():
            cols[col] = _txt(f.get(af))
        for af, col in COL_ARR.items():
            cols[col] = _arr(f.get(af))
        for af, col in COL_CHECK.items():
            cols[col] = bool(_bool(f.get(af)))   # NOT NULL → default False
        for af, col in COL_TRIBOOL.items():
            cols[col] = _bool(f.get(af))          # nullable tri-state
        # intake jsonb
        intake = {}
        for af, key in INTAKE_MAP.items():
            v = f.get(af)
            if v not in (None, "", []):
                intake[key] = v
        cols["intake"] = json.dumps(intake)

        # dynamic UPSERT on user_id
        keys = list(cols.keys())
        ph = [f"${i+1}" for i in range(len(keys))]
        updates = ", ".join(f"{k}=EXCLUDED.{k}" for k in keys if k != "user_id")
        sql = (f"INSERT INTO bedrock.builder_job_profile ({', '.join(keys)}) "
               f"VALUES ({', '.join(ph)}) "
               f"ON CONFLICT (user_id) DO UPDATE SET {updates}, updated_at=now()")
        await conn.execute(sql, *[cols[k] for k in keys])
        counts["upserted"] += 1

    total = await conn.fetchval("SELECT count(*) FROM bedrock.builder_job_profile")
    await conn.close()
    print(f"\nFetched {len(recs)} Airtable builders")
    print(f"  matched by email: {counts['email']} | by name: {counts['name']} | "
          f"ambiguous: {counts['ambiguous']} | unmatched: {counts['unmatched']}")
    print(f"  upserted: {counts['upserted']} | table total now: {total}")


if __name__ == "__main__":
    asyncio.run(main())
