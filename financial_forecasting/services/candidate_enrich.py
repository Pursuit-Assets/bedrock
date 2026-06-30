"""AI-first enrichment + linkage suggestions for email-review candidates.

Two capabilities, both used by the candidate-review UI:
  - suggest_account(): rule-based, fast — map a candidate's email domain to an
    existing jobs account (exact domain map → fuzzy domain-root → none).
  - enrich_candidate(): Claude (Haiku) reads the person's emails (subjects +
    bodies/signatures) and extracts {full_name, title, company, linkedin_url,
    is_employer_contact, confidence, reasoning} so the reviewer starts from a
    filled-in, high-signal draft instead of a blank row.
"""
from __future__ import annotations
import json, logging, os
from typing import Any, Optional

logger = logging.getLogger(__name__)

PERSONAL_DOMAINS = {
    "gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","me.com",
    "aol.com","live.com","msn.com","proton.me","protonmail.com","att.net",
}


# ── Account linkage suggestion (rule-based) ───────────────────────────────────

async def suggest_account(conn, email: str) -> Optional[dict]:
    """Best existing jobs account for this email's domain, or None.

    Order: exact account_email_domain map → domain-root fuzzy match against
    account names → none. Personal domains never match an account.
    """
    if not email or "@" not in email:
        return None
    domain = email.split("@")[-1].lower().strip()
    if domain in PERSONAL_DOMAINS:
        return None

    # 1) Exact domain → SF account map (high confidence)
    row = await conn.fetchrow(
        "SELECT sf_account_id, sf_account_name FROM bedrock.account_email_domain WHERE domain=$1", domain)
    if row and row["sf_account_name"]:
        key = row["sf_account_name"].strip().lower()
        # Does that account already exist in the jobs hub (opp or jobs-contact company)?
        exists = await conn.fetchval(
            """SELECT 1 FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND lower(trim(account_name))=$1
               UNION SELECT 1 FROM public.contacts WHERE is_jobs_contact=true AND lower(trim(current_company))=$1 LIMIT 1""",
            key)
        return {"account_key": key, "account_name": row["sf_account_name"],
                "sf_account_id": row["sf_account_id"], "confidence": "high",
                "in_pipeline": bool(exists),
                "reason": f"Email domain {domain} maps to {row['sf_account_name']} in Salesforce"}

    # 2) Domain-root fuzzy match against existing jobs account names
    root = domain.split(".")[0]
    if len(root) >= 4:
        cand = await conn.fetchrow(
            """SELECT account_name FROM (
                 SELECT DISTINCT account_name FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL AND coalesce(trim(account_name),'')<>''
                 UNION SELECT DISTINCT current_company FROM public.contacts WHERE is_jobs_contact=true AND coalesce(trim(current_company),'')<>''
               ) a
               WHERE lower(replace(account_name,' ','')) LIKE '%'||$1||'%' OR $1 LIKE '%'||lower(replace(account_name,' ',''))||'%'
               ORDER BY length(account_name) LIMIT 1""", root)
        if cand:
            key = cand["account_name"].strip().lower()
            return {"account_key": key, "account_name": cand["account_name"].strip(),
                    "sf_account_id": None, "confidence": "medium", "in_pipeline": True,
                    "reason": f"Domain root '{root}' resembles existing account '{cand['account_name'].strip()}'"}

    # 3) No match — propose a new account named after the domain
    return {"account_key": None, "account_name": root.capitalize(), "sf_account_id": None,
            "confidence": "low", "in_pipeline": False,
            "reason": f"No existing account for {domain}; suggest creating one"}


# ── AI enrichment (Claude Haiku) ──────────────────────────────────────────────

_SYSTEM = (
    "You extract structured contact info for a jobs/employer-relationship CRM. "
    "Given a person's email address and the emails our team exchanged with them, "
    "infer who they are. Use email signatures, sign-offs, titles, and company "
    "context. Only state what the evidence supports; use null when unknown. "
    "Respond with ONLY a JSON object, no prose."
)
_SCHEMA_HINT = (
    '{"full_name": str|null, "title": str|null, "company": str|null, '
    '"linkedin_url": str|null, "is_employer_contact": bool, '
    '"confidence": "high"|"medium"|"low", "reasoning": str}'
)


def enrich_candidate(email: str, emails: list[dict]) -> dict:
    """Claude reads the candidate's emails and returns structured fields.

    `emails`: list of {subject, body, direction, date}. Returns the parsed dict
    (or {"error": ...} on failure). is_employer_contact flags whether this looks
    like a real employer/partner contact vs. personal/noise — so reviewers can
    fast-dismiss the latter.
    """
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key:
        return {"error": "ANTHROPIC_API_KEY not set"}
    try:
        import anthropic
    except ImportError:
        return {"error": "anthropic SDK not installed"}

    # Build a compact, capped transcript (newest first), trimming long bodies.
    parts = [f"Candidate email address: {email}", ""]
    for e in emails[:6]:
        body = (e.get("body") or e.get("snippet") or "").strip().replace("\r", "")
        # Keep head AND tail when long — email signatures (title/company/phone/
        # LinkedIn) sit at the bottom, so a top-only truncation loses them.
        if len(body) > 1400:
            body = body[:900] + "\n…[trimmed]…\n" + body[-500:]
        parts.append(f"[{e.get('direction','?')} · {e.get('date','')}] Subject: {e.get('subject') or '(none)'}")
        if body:
            parts.append(body)
        parts.append("")
    transcript = "\n".join(parts)[:6000]

    prompt = (
        f"{transcript}\n\n"
        f"Extract this person as JSON matching exactly:\n{_SCHEMA_HINT}\n"
        "company should be the person's employer (prefer a clean canonical name). "
        "linkedin_url only if it literally appears. Respond with only the JSON."
    )
    try:
        client = anthropic.Anthropic(api_key=key)
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001", max_tokens=400,
            system=_SYSTEM, messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
        if text.startswith("```"):
            text = text.split("```")[1].lstrip("json").strip()
        data = json.loads(text)
        return {
            "full_name": data.get("full_name"), "title": data.get("title"),
            "company": data.get("company"), "linkedin_url": data.get("linkedin_url"),
            "is_employer_contact": bool(data.get("is_employer_contact", True)),
            "confidence": data.get("confidence", "low"),
            "reasoning": data.get("reasoning", ""),
        }
    except Exception as e:
        logger.warning("candidate enrich failed for %s: %s", email, e)
        return {"error": str(e)[:160]}


# ── Persisted / batch enrichment ──────────────────────────────────────────────

async def find_duplicate_contacts(conn, contact_id: int, name: str) -> list[int]:
    """Existing pipeline contact ids that are plausibly the SAME PERSON.

    Requires a real first AND last name, both present on the candidate — a
    shared first name alone ("Rachel") is NOT a match and returns []. This keeps
    the "likely existing contact" suggestion tight; company linkage is handled
    separately by the account suggestion.
    """
    parts = [p for p in (name or "").split() if len(p) >= 2]
    if len(parts) < 2:
        return []
    first, last = parts[0], parts[-1]
    if first.lower() == last.lower():
        return []
    rows = await conn.fetch(
        """SELECT contact_id FROM public.contacts
           WHERE is_jobs_contact = true AND coalesce(contact_stage,'') NOT IN ('candidate','dismissed','merged')
             AND contact_id <> $1
             AND full_name ILIKE $2 AND full_name ILIKE $3
           LIMIT 6""",
        contact_id, f"%{first}%", f"%{last}%")
    return [r["contact_id"] for r in rows]


# ── Salesforce contact matching (MECE: email is the key) ──────────────────────

# A fellow/known contact's personal email can live in any of these SF fields.
SF_EMAIL_FIELDS = ("Email", "npe01__HomeEmail__c", "npe01__WorkEmail__c")


def sf_contact_match_soql(emails: list[str]) -> str:
    """SOQL to find SF Contacts whose any email field matches one of `emails`."""
    quoted = ",".join("'" + e.replace("'", r"\'") + "'" for e in emails if e)
    clauses = " OR ".join(f"{f} IN ({quoted})" for f in SF_EMAIL_FIELDS)
    return (
        "SELECT Id, Name, Email, npe01__HomeEmail__c, npe01__WorkEmail__c, Title, "
        "AccountId, Account.Name FROM Contact "
        f"WHERE {clauses} LIMIT 400"
    )


def index_sf_matches(records: list[dict]) -> dict[str, dict]:
    """Map each candidate email (lowercased) → its SF contact record. A contact
    can match on several email fields; we index all of them."""
    out: dict[str, dict] = {}
    for r in records or []:
        acct = (r.get("Account") or {}).get("Name") if isinstance(r.get("Account"), dict) else None
        info = {"sf_contact_id": r.get("Id"), "name": r.get("Name"), "title": r.get("Title"),
                "account_id": r.get("AccountId"), "account_name": acct}
        for f in SF_EMAIL_FIELDS:
            v = r.get(f)
            if v:
                out.setdefault(v.lower().strip(), info)
    return out


async def enrich_and_store(conn, contact_id: int) -> dict:
    """Run AI enrichment + account suggestion + duplicate detection for one
    candidate and persist to bedrock.candidate_enrichment (upsert). Returns the
    stored record. Safe to re-run (idempotent upsert)."""
    import asyncio, json
    c = await conn.fetchrow("SELECT email FROM public.contacts WHERE contact_id=$1", contact_id)
    if not c:
        return {}
    # Prefer the person's OWN emails (inbound) first — that's where their
    # signature (title/company/phone/LinkedIn) lives. Full body (capped) so the
    # signature at the bottom isn't truncated away.
    rows = await conn.fetch(
        """SELECT subject, left(coalesce(email_body_text, email_snippet), 6000) AS body,
                  activity_date::date::text AS date,
                  (email_from NOT ILIKE '%pursuit%') AS inbound
           FROM bedrock.activity WHERE participant_public_contact_id=$1 AND deleted_at IS NULL
           ORDER BY (email_from NOT ILIKE '%pursuit%') DESC, activity_date DESC LIMIT 6""", contact_id)
    emails = [{"subject": r["subject"], "body": r["body"], "date": r["date"],
               "direction": "inbound (from them)" if r["inbound"] else "outbound (to them)"} for r in rows]
    ai = await asyncio.to_thread(enrich_candidate, c["email"], emails)
    sug = await suggest_account(conn, c["email"])
    dup_ids = await find_duplicate_contacts(conn, contact_id, ai.get("full_name") or "")
    await conn.execute(
        """INSERT INTO bedrock.candidate_enrichment
           (contact_id, full_name, title, company, linkedin_url, is_employer_contact,
            confidence, reasoning, account_suggestion, possible_duplicate_ids, model, enriched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now())
           ON CONFLICT (contact_id) DO UPDATE SET
             full_name=EXCLUDED.full_name, title=EXCLUDED.title, company=EXCLUDED.company,
             linkedin_url=EXCLUDED.linkedin_url, is_employer_contact=EXCLUDED.is_employer_contact,
             confidence=EXCLUDED.confidence, reasoning=EXCLUDED.reasoning,
             account_suggestion=EXCLUDED.account_suggestion,
             possible_duplicate_ids=EXCLUDED.possible_duplicate_ids,
             model=EXCLUDED.model, enriched_at=now()""",
        contact_id, ai.get("full_name"), ai.get("title"), ai.get("company"),
        ai.get("linkedin_url"), ai.get("is_employer_contact"), ai.get("confidence"),
        ai.get("reasoning") or (ai.get("error") and f"error: {ai['error']}") or "",
        json.dumps(sug) if sug else None, dup_ids, "claude-haiku-4-5-20251001")
    return {"contact_id": contact_id, "ai": ai, "account_suggestion": sug, "possible_duplicate_ids": dup_ids}
