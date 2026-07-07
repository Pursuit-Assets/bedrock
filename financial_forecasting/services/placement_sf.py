"""Placement → Salesforce sync.

When a job placement is confirmed in bedrock (a builder hired into a role →
public.employment_records), mirror it into Salesforce the way fellows are
modeled there (verified against live records 2026-07-02):

  - Contact, RecordType "Pursuit Fellow"      — the builder (match by email,
    else exact name among fellow/alumni record types; create if net-new)
  - Account                                    — the employer (match by exact
    name; create if net-new)
  - npe5__Affiliation__c                       — links them, npe5__Role__c =
    role title, npe5__StartDate__c = start date, npe5__Status__c = 'Current'

Idempotent per employment_record via bedrock.placement_sf_sync. The `sf`
object needs async `query(soql)` and `create_record(sobject, data)` — both the
app's UnifiedMCPClient.salesforce and the backfill script's REST shim qualify.
"""

import logging
from typing import Any, Dict, Optional

from security import escape_soql_string

logger = logging.getLogger(__name__)

FELLOW_RECORD_TYPES = ("Pursuit Fellow", "Pursuit Core Fellow", "Pursuit Advance Fellow", "Alumni")
_fellow_rt_id: Optional[str] = None
_fellow_aff_rt_id: Optional[str] = None


def _rid(res) -> Optional[str]:
    if isinstance(res, dict):
        return res.get("id") or res.get("Id")
    return None


def _temp_or_permanent(er) -> str:
    """Fellow Affiliation's required Temporary_vs_Permanent__c: internships,
    apprenticeships, trials, and contract/freelance are Temporary; everything
    else (full-time, direct hires) is Permanent."""
    et = (er["employment_type"] or "").lower()
    title = (er["role_title"] or "").lower()
    if (et in ("internship", "apprenticeship", "contract", "freelance", "temporary", "part_time")
            or any(k in title for k in ("intern", "apprentice", "trial"))):
        return "Temporary"
    return "Permanent"


async def _fellow_record_type_id(sf) -> Optional[str]:
    global _fellow_rt_id
    if _fellow_rt_id:
        return _fellow_rt_id
    res = await sf.query(
        "SELECT Id FROM RecordType WHERE SobjectType='Contact' AND DeveloperName='Pursuit_Fellow' LIMIT 1")
    recs = res.get("records", [])
    _fellow_rt_id = recs[0]["Id"] if recs else None
    return _fellow_rt_id


async def _fellow_affiliation_record_type_id(sf) -> Optional[str]:
    """RecordType for the affiliation itself — jobs placements must be a
    'Fellow Affiliation', not the default 'Standard Affiliation' (which drops
    most of the fellow-specific fields). Resolved at runtime (id varies by org)."""
    global _fellow_aff_rt_id
    if _fellow_aff_rt_id:
        return _fellow_aff_rt_id
    res = await sf.query(
        "SELECT Id FROM RecordType WHERE SobjectType='npe5__Affiliation__c' "
        "AND DeveloperName='Fellow_Affiliation' LIMIT 1")
    recs = res.get("records", [])
    _fellow_aff_rt_id = recs[0]["Id"] if recs else None
    return _fellow_aff_rt_id


class NotEligible(Exception):
    """Placement shouldn't go to Salesforce (policy, not an error)."""


class AccountAmbiguous(Exception):
    """SF has close-but-not-exact account name matches — a human should pick
    (link an existing account) or explicitly confirm creating a new one.
    `candidates` = [{id, name}] of the near matches."""

    def __init__(self, company: str, candidates):
        self.company = company
        self.candidates = candidates
        names = ", ".join(f"'{c['name']}'" for c in candidates[:4])
        super().__init__(
            f"Salesforce has similar account(s) to '{company}': {names}. "
            "Pick one to link, or confirm creating a new account.")


_LEGAL_SUFFIXES = (
    "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp",
    "corporation", "co", "company", "pbc", "plc", "gmbh",
)


def _norm_company(name: str) -> str:
    """Lowercase, strip punctuation and trailing legal suffixes —
    'Acture Solutions, Inc.' → 'acture solutions'."""
    import re
    s = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower())
    words = [w for w in s.split() if w]
    while words and words[-1] in _LEGAL_SUFFIXES:
        words.pop()
    return " ".join(words)


def sync_eligibility(er) -> Optional[str]:
    """Return a skip-reason when a placement should NOT sync to Salesforce.

    Policy (agreed 2026-07-06): only PAID employment creates an SF
    affiliation — full-time roles, or anything with a payment amount.
    Capstones/volunteer/pro-bono work and a fellow's own venture stay out of
    the org-wide CRM (an affiliation there reads as employment). Applies the
    same regardless of whether the record is linked to a jobs deal.
    """
    if er["is_own_venture"]:
        return "own venture — not an employer relationship"
    paid = (er["payment_amount"] or 0) > 0
    if er["employment_type"] != "full_time" and not paid:
        return f"unpaid {er['employment_type'] or 'engagement'} — only paid work syncs"
    return None


async def sync_placement_to_sf(
    conn, sf, employment_record_id: int,
    sf_account_id_override: Optional[str] = None,
    force_create_account: bool = False,
) -> Dict[str, Any]:
    """Ensure SF contact + account + affiliation exist for one placement.

    Raises ValueError when required info is missing, NotEligible under the
    paid-work policy, and AccountAmbiguous when SF has close-but-not-exact
    account names (resolve by passing sf_account_id_override to link one, or
    force_create_account=True to create anyway)."""
    er = await conn.fetchrow(
        "SELECT id, user_id, role_title, company_name, employment_type, start_date, "
        "       payment_amount, is_own_venture "
        "FROM public.employment_records WHERE id=$1", employment_record_id)
    if not er:
        raise ValueError("Placement not found")
    skip = sync_eligibility(er)
    if skip:
        raise NotEligible(skip)
    company = (er["company_name"] or "").strip()
    if not company or company.upper() == "TBD":
        raise ValueError("This placement has no employer name — set the company before syncing to Salesforce.")
    builder = await conn.fetchrow("SELECT * FROM bedrock.builder_by_id($1)", er["user_id"])
    if not builder or not (builder["full_name"] or "").strip():
        raise ValueError("Couldn't resolve the builder for this placement — check the hire's builder.")
    b_name = builder["full_name"].strip()
    b_email = (builder["email"] or "").strip()

    out: Dict[str, Any] = {"employment_record_id": employment_record_id,
                           "created_contact": False, "created_account": False, "created_affiliation": False}

    # ── Account — smartest safe match, never a silent near-duplicate ─────────
    #   1. caller override (user picked an SF account, or confirmed create)
    #   2. exact name match
    #   3. normalized match (case/punctuation/legal suffixes) — auto when unique
    #   4. close matches exist (shared lead word / prefix) → AccountAmbiguous,
    #      surfaced as needs_info with the candidates for a human to pick
    #   5. nothing similar → create
    safe_co = escape_soql_string(company)
    if sf_account_id_override:
        sf_account_id = sf_account_id_override
    else:
        res = await sf.query(f"SELECT Id, Name FROM Account WHERE Name = '{safe_co}' LIMIT 2")
        accts = res.get("records", [])
        sf_account_id = accts[0]["Id"] if accts else None
        if not sf_account_id:
            # candidates sharing the lead word or prefixing each other
            lead = escape_soql_string(_norm_company(company).split(" ")[0] if _norm_company(company) else company)
            res = await sf.query(
                f"SELECT Id, Name FROM Account WHERE Name LIKE '{lead}%' LIMIT 10")
            cands = [{"id": r["Id"], "name": r["Name"]} for r in res.get("records", [])]
            norm = _norm_company(company)
            exact_norm = [c for c in cands if _norm_company(c["name"]) == norm]
            if len(exact_norm) == 1:
                sf_account_id = exact_norm[0]["id"]      # e.g. 'Acture Solutions, Inc.'
            elif cands and not force_create_account:
                raise AccountAmbiguous(company, cands)   # e.g. SF has 'Acture'
        if not sf_account_id:
            created = await sf.create_record("Account", {"Name": company})
            sf_account_id = _rid(created)
            if not sf_account_id:
                raise ValueError(f"Salesforce account create failed: {created}")
            out["created_account"] = True
    out["sf_account_id"] = sf_account_id

    # ── Contact (email first — fellows carry personal emails in SF — then
    #    exact name among fellow/alumni record types) ─────────────────────────
    sf_contact_id = None
    if b_email:
        res = await sf.query(
            f"SELECT Id FROM Contact WHERE Email = '{escape_soql_string(b_email)}' LIMIT 1")
        recs = res.get("records", [])
        sf_contact_id = recs[0]["Id"] if recs else None
    if not sf_contact_id:
        rt_list = ", ".join(f"'{t}'" for t in FELLOW_RECORD_TYPES)
        res = await sf.query(
            f"SELECT Id FROM Contact WHERE Name = '{escape_soql_string(b_name)}' "
            f"AND RecordType.Name IN ({rt_list}) LIMIT 2")
        recs = res.get("records", [])
        if len(recs) == 1:
            sf_contact_id = recs[0]["Id"]
    if not sf_contact_id:
        parts = b_name.split()
        first, last = (parts[0], " ".join(parts[1:])) if len(parts) > 1 else ("", parts[0])
        data = {"FirstName": first, "LastName": last}
        if b_email:
            data["Email"] = b_email
        rt = await _fellow_record_type_id(sf)
        if rt:
            data["RecordTypeId"] = rt
        created = await sf.create_record("Contact", data)
        sf_contact_id = _rid(created)
        if not sf_contact_id:
            raise ValueError(f"Salesforce contact create failed: {created}")
        out["created_contact"] = True
    out["sf_contact_id"] = sf_contact_id

    # ── Affiliation (skip if one already links this pair) ────────────────────
    res = await sf.query(
        f"SELECT Id FROM npe5__Affiliation__c WHERE npe5__Contact__c = '{sf_contact_id}' "
        f"AND npe5__Organization__c = '{sf_account_id}' LIMIT 1")
    recs = res.get("records", [])
    aff_rt = await _fellow_affiliation_record_type_id(sf)
    # Fellow-affiliation fields the rest of the app reads to resolve a fellow's
    # employer: WITHOUT Account_ForFellowsOnly__c + npe5__Primary__c the record is
    # invisible to /accounts/with-fellows and candidate/builder employer lookups
    # (candidate_enrich, sf_contact_matcher) — the real "missing data" gap.
    fellow_fields = {
        "npe5__Status__c": "Current",
        "Account_ForFellowsOnly__c": sf_account_id,
        "npe5__Primary__c": True,
        "Temporary_vs_Permanent__c": _temp_or_permanent(er),
    }
    if aff_rt:
        fellow_fields["RecordTypeId"] = aff_rt
    if er["role_title"] and er["role_title"].upper() != "TBD":
        fellow_fields["npe5__Role__c"] = er["role_title"]
    if er["start_date"]:
        fellow_fields["npe5__StartDate__c"] = er["start_date"].isoformat()

    if recs:
        # An affiliation already links this pair — heal it into a complete Fellow
        # affiliation (older ones were Standard / missing the fellow fields).
        sf_affiliation_id = recs[0]["Id"]
        await sf.update_record("npe5__Affiliation__c", sf_affiliation_id, fellow_fields)
    else:
        aff = {"npe5__Contact__c": sf_contact_id, "npe5__Organization__c": sf_account_id, **fellow_fields}
        created = await sf.create_record("npe5__Affiliation__c", aff)
        sf_affiliation_id = _rid(created)
        if not sf_affiliation_id:
            raise ValueError(f"Salesforce affiliation create failed: {created}")
        out["created_affiliation"] = True
    out["sf_affiliation_id"] = sf_affiliation_id

    await conn.execute(
        """INSERT INTO bedrock.placement_sf_sync
             (employment_record_id, sf_contact_id, sf_account_id, sf_affiliation_id,
              created_contact, created_account, created_affiliation, status, error, synced_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'synced',NULL,now(),now())
           ON CONFLICT (employment_record_id) DO UPDATE
             SET sf_contact_id=$2, sf_account_id=$3, sf_affiliation_id=$4,
                 created_contact=$5, created_account=$6, created_affiliation=$7,
                 status='synced', error=NULL, updated_at=now()""",
        employment_record_id, sf_contact_id, sf_account_id, sf_affiliation_id,
        out["created_contact"], out["created_account"], out["created_affiliation"])
    return out


async def record_sync_error(conn, employment_record_id: int, error: str, status: str = "error") -> None:
    """Record a non-synced outcome — status 'error' (retryable failure) or
    'skipped' (paid-work policy exclusion, shown but not retried)."""
    await conn.execute(
        """INSERT INTO bedrock.placement_sf_sync (employment_record_id, status, error, updated_at)
           VALUES ($1,$3,$2,now())
           ON CONFLICT (employment_record_id) DO UPDATE SET status=$3, error=$2, updated_at=now()""",
        employment_record_id, error[:2000], status)
