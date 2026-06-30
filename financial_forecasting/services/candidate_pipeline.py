"""Nightly candidate pipeline — turns newly-synced email/calendar activity into
linked contacts or reviewable candidates, with zero human babysitting.

Runs after the gmail/calendar sync + relink pass. For every external counterparty
in recent activity that the staff team touched:
  1. If the address resolves to an existing contact (primary email OR the
     bedrock.contact_email_alias index — which includes all mirrored Salesforce
     contacts) → link the activity to it. (SF matching is local because SF
     contacts are mirrored + aliased; no live SF auth needed in the nightly.)
  2. Otherwise → create a review CANDIDATE (contact_stage='candidate',
     source='email_candidate'), company resolved from the email domain, name
     from the local-part where derivable, the activity linked, the address
     aliased, and owner/channel/tier recorded in bedrock.email_candidate so the
     per-owner home card + filter work.

Idempotent and incremental: `days_back` bounds it to recent activity; addresses
that are already contacts/aliases are skipped, so re-running is cheap.
"""
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

INTERNAL_DOMAINS = {"pursuit.org", "pursuit.com"}
FREEMAIL = {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com",
            "me.com", "msn.com", "live.com", "proton.me", "protonmail.com", "gmx.com", "ymail.com"}
AUTO_LOCAL = {"support", "info", "no-reply", "noreply", "notifications", "notification", "reminder",
              "hello", "team", "donotreply", "do-not-reply", "mailer-daemon", "admin", "contact",
              "sales", "help", "news", "newsletter", "billing", "accounts", "careers", "jobs", "hr",
              "postmaster", "bounce", "mailer", "google", "calendar-notification"}
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")


def _dom(a: str) -> str:
    return a.split("@", 1)[1].lower() if a and "@" in a else ""


def _droot(a: str) -> str:
    d = _dom(a); p = d.split("."); return p[-2] if len(p) >= 2 else d


def _localpart_name(addr: str) -> Optional[str]:
    """first.last / first_last -> 'First Last'. Single-token -> None (don't guess)."""
    lp = addr.split("@", 1)[0]
    parts = [p for p in re.split(r"[._\-]", lp) if p.isalpha() and len(p) > 1]
    if len(parts) >= 2:
        return " ".join(w.capitalize() for w in parts[:2])
    return None


def _emails_in(*vals) -> list:
    out = []
    for v in vals:
        if not v:
            continue
        items = v if isinstance(v, list) else [v]
        for it in items:
            if isinstance(it, dict):
                e = (it.get("email") or "").lower().strip()
                if e:
                    out.append(e)
            else:
                out += [m.lower() for m in EMAIL_RE.findall(it or "")]
    return out


async def resolve_and_queue_candidates(conn, days_back: Optional[int] = 3,
                                       staff_emails: Optional[list] = None) -> dict[str, Any]:
    """Link-or-queue every external counterparty in recent team activity.
    Returns {"linked_via_alias": n, "candidates_created": n, "activity_linked": n}."""
    # staff roster (who counts as an internal owner)
    staff = set(r["email"].lower() for r in await conn.fetch(
        "SELECT email FROM bedrock.sync_staff WHERE email IS NOT NULL"))
    if staff_emails:
        staff |= {e.lower() for e in staff_emails}

    # contact + alias resolution index (includes mirrored SF contacts)
    cmap: dict = {}
    for r in await conn.fetch(
        "SELECT contact_id, lower(email) e FROM public.contacts "
        "WHERE email IS NOT NULL AND email <> '' AND coalesce(contact_stage,'') <> 'merged'"):
        cmap.setdefault(r["e"], r["contact_id"])
    for r in await conn.fetch(
        "SELECT lower(address) a, public_contact_id cid FROM bedrock.contact_email_alias"):
        cmap.setdefault(r["a"], r["cid"])

    # company resolution
    comp_by_dom = {r["domain"].lower(): r["company_id"] for r in await conn.fetch(
        "SELECT lower(domain) domain, company_id FROM public.companies WHERE domain IS NOT NULL AND domain <> ''")}
    comp_by_name = {(r["n"] or "").strip().lower(): r["company_id"] for r in await conn.fetch(
        "SELECT lower(name) n, company_id FROM public.companies WHERE name IS NOT NULL")}
    aed = {r["domain"].lower(): r["sf_account_name"] for r in await conn.fetch(
        "SELECT lower(domain) domain, sf_account_name FROM bedrock.account_email_domain "
        "WHERE domain IS NOT NULL AND sf_account_name IS NOT NULL")}

    def internal(a: str) -> bool:
        return _dom(a) in INTERNAL_DOMAINS or a in staff or "calendar.google.com" in _dom(a)

    def is_auto(a: str) -> bool:
        return a.split("@", 1)[0].lower() in AUTO_LOCAL

    bound = ""
    params: list = []
    if days_back is not None:
        bound = "AND a.activity_date >= now() - ($1 || ' days')::interval"
        params = [str(days_back)]
    rows = await conn.fetch(f"""
        SELECT a.id, a.email_from, a.email_to, a.email_cc, a.meeting_attendees,
               a.source, a.activity_date, a.participant_public_contact_id AS pid
        FROM bedrock.activity a
        WHERE a.deleted_at IS NULL AND a.source IN ('gmail-sync', 'calendar-sync') {bound}
    """, *params)

    # gather, per external address: owners, channels, freq, last_date, name, activity ids
    from collections import defaultdict
    owners = defaultdict(set); channels = defaultdict(set); freq = defaultdict(int)
    last = defaultdict(lambda: None); name_for = defaultdict(lambda: None)
    acts = defaultdict(list); already = {}
    for r in rows:
        frm = r["email_from"]
        # parse sender display name
        nm = None; faddr = None
        if frm:
            m = re.match(r'^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$', frm)
            if m:
                nm = (m.group(1).strip() or None); faddr = m.group(2).lower().strip()
            else:
                em = EMAIL_RE.search(frm); faddr = em.group(0).lower() if em else None
        alla = set(_emails_in(frm, r["email_to"], r["email_cc"], r["meeting_attendees"]))
        who = [a for a in alla if a in staff]
        if not who:
            continue
        ch = "meeting" if r["source"] == "calendar-sync" else "email"
        for x in alla:
            if internal(x) or is_auto(x):
                continue
            freq[x] += 1; acts[x].append(r["id"])
            for w in who:
                owners[x].add(w)
            channels[x].add(ch)
            if r["activity_date"] and (last[x] is None or r["activity_date"] > last[x]):
                last[x] = r["activity_date"]
            if x == faddr and nm and not name_for[x]:
                name_for[x] = nm
            if x in cmap:
                already[x] = cmap[x]

    linked_alias = 0; created = 0; activity_linked = 0
    # 1) LINK addresses that resolve to an existing contact/alias
    for addr, cid in already.items():
        ids = acts.get(addr, [])
        if ids:
            res = await conn.execute(
                "UPDATE bedrock.activity SET participant_public_contact_id=$1 "
                "WHERE id = ANY($2) AND participant_public_contact_id IS NULL", cid, ids)
            n = int(res.split()[-1]) if res and res.split()[-1].isdigit() else 0
            activity_linked += n
        await conn.execute(
            "INSERT INTO bedrock.contact_email_alias (address, public_contact_id, source, first_seen, last_seen) "
            "VALUES ($1,$2,'nightly_link',now(),now()) ON CONFLICT (address) DO NOTHING", addr, cid)
        linked_alias += 1

    # 2) CREATE candidates for net-new addresses
    await conn.execute("""CREATE TABLE IF NOT EXISTS bedrock.email_candidate (
        contact_id int PRIMARY KEY, owners text[], channels text[], freq int,
        last_activity timestamptz, tier text, updated_at timestamptz default now())""")
    for addr in [a for a in freq if a not in already]:
        d = _dom(addr); company = None; company_id = None
        if d and d not in FREEMAIL:
            company_id = comp_by_dom.get(d)
            company = aed.get(d) or _droot(addr)
            if not company_id and company and company.strip().lower() in comp_by_name:
                company_id = comp_by_name[company.strip().lower()]
        nm = name_for[addr] or _localpart_name(addr)
        first = nm.split()[0] if nm else None
        last_n = " ".join(nm.split()[1:]) if nm and len(nm.split()) > 1 else None
        cid = await conn.fetchval("""
            INSERT INTO public.contacts (full_name, first_name, last_name, email, current_company, company_id,
                is_jobs_contact, contact_stage, source, tags, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,false,'candidate','email_candidate', ARRAY['email_review'], now(), now())
            ON CONFLICT (email) DO NOTHING RETURNING contact_id""",
            nm or addr, first, last_n, addr, company, company_id)
        if not cid:
            cid = await conn.fetchval("SELECT contact_id FROM public.contacts WHERE lower(email)=$1", addr)
            if not cid:
                continue
        else:
            created += 1
        await conn.execute(
            "INSERT INTO bedrock.contact_email_alias (address, public_contact_id, source, first_seen, last_seen) "
            "VALUES ($1,$2,'email_candidate',now(),now()) ON CONFLICT (address) DO NOTHING", addr, cid)
        ids = acts.get(addr, [])
        if ids:
            res = await conn.execute(
                "UPDATE bedrock.activity SET participant_public_contact_id=$1 "
                "WHERE id = ANY($2) AND participant_public_contact_id IS NULL", cid, ids)
            n = int(res.split()[-1]) if res and res.split()[-1].isdigit() else 0
            activity_linked += n
        tier = ("ready" if (company_id and nm) else "needs_name" if company_id
                else "review")
        await conn.execute("""INSERT INTO bedrock.email_candidate (contact_id, owners, channels, freq, last_activity, tier, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,now())
            ON CONFLICT (contact_id) DO UPDATE SET owners=$2, channels=$3, freq=$4, last_activity=$5, tier=$6, updated_at=now()""",
            cid, sorted(owners[addr]), sorted(channels[addr]), freq[addr], last[addr], tier)

    logger.info("candidate pipeline: linked %d via alias, created %d candidates, %d activity rows linked",
                linked_alias, created, activity_linked)
    return {"linked_via_alias": linked_alias, "candidates_created": created, "activity_linked": activity_linked}
