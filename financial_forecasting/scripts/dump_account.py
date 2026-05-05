"""One-shot: dump everything we can find about an Account from Salesforce.

Pulls Account, related Contacts, Opportunities (with stage history),
Tasks, Events, and Notes. Writes a single Markdown report.

Usage (from financial_forecasting/):

    SF_INSTANCE_URL='https://YOURORG.my.salesforce.com' \\
    SF_SESSION_ID='<token>' \\
    python -m scripts.dump_account "Con Edison" --out con-edison-dump.md

    # or with username/password/token
    SALESFORCE_USERNAME=... SALESFORCE_PASSWORD=... \\
    SALESFORCE_SECURITY_TOKEN=... \\
    python -m scripts.dump_account "Con Ed"

Account match is fuzzy: SOQL `Name LIKE '%<query>%'`. If multiple match,
all are included in the report (with a header per account).

Designed for one-off research — does not write to Postgres, does not
modify SF.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List

from dotenv import load_dotenv
from simple_salesforce import Salesforce

load_dotenv(override=False)


# ── SF auth ───────────────────────────────────────────────────────────────


def _build_sf_client() -> Salesforce:
    instance = os.getenv("SF_INSTANCE_URL")
    session_id = os.getenv("SF_SESSION_ID")
    if instance and session_id:
        # simple_salesforce wants instance host without scheme for the
        # session-token path
        host = instance.replace("https://", "").replace("http://", "").rstrip("/")
        return Salesforce(instance=host, session_id=session_id)

    username = os.getenv("SALESFORCE_USERNAME")
    password = os.getenv("SALESFORCE_PASSWORD")
    token = os.getenv("SALESFORCE_SECURITY_TOKEN")
    domain = os.getenv("SALESFORCE_DOMAIN", "login")
    if not (username and password and token):
        raise SystemExit(
            "No SF credentials. Set SF_INSTANCE_URL+SF_SESSION_ID, or "
            "SALESFORCE_USERNAME+PASSWORD+SECURITY_TOKEN."
        )
    return Salesforce(
        username=username, password=password, security_token=token, domain=domain
    )


# ── SOQL helpers ──────────────────────────────────────────────────────────


def _esc(s: str) -> str:
    """Escape single quotes for SOQL."""
    return s.replace("'", r"\'")


def _records(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    return result.get("records", []) or []


def _strip_attrs(rec: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in rec.items() if k != "attributes"}


# ── Pulls ─────────────────────────────────────────────────────────────────


_SF_ID_RE = __import__("re").compile(r"^[a-zA-Z0-9]{15,18}$")
_ACCOUNT_FIELDS = (
    "Id, Name, Type, Industry, Website, Phone, BillingCity, "
    "BillingState, BillingCountry, AccountSource, OwnerId, Owner.Name, "
    "RecordTypeId, RecordType.Name, NumberOfEmployees, Description, "
    "AnnualRevenue, ParentId, IsDeleted, CreatedDate, CreatedById, "
    "LastModifiedDate, LastActivityDate"
)


def find_accounts(sf: Salesforce, query: str) -> List[Dict[str, Any]]:
    """Exact-match on SF Id if `query` looks like one; otherwise LIKE on Name."""
    if _SF_ID_RE.match(query):
        soql = f"SELECT {_ACCOUNT_FIELDS} FROM Account WHERE Id = '{query}'"
    else:
        soql = (
            f"SELECT {_ACCOUNT_FIELDS} FROM Account "
            f"WHERE Name LIKE '%{_esc(query)}%' AND IsDeleted = false "
            "ORDER BY Name"
        )
    return _records(sf.query_all(soql))


def fetch_contacts(sf: Salesforce, account_id: str) -> List[Dict[str, Any]]:
    soql = (
        "SELECT Id, FirstName, LastName, Title, Email, Phone, MobilePhone, "
        "Department, MailingCity, MailingState, OwnerId, Owner.Name, "
        "AccountId, ReportsToId, ReportsTo.Name, LeadSource, "
        "Description, IsDeleted, CreatedDate, LastModifiedDate, "
        "LastActivityDate "
        f"FROM Contact WHERE AccountId = '{account_id}' "
        "AND IsDeleted = false ORDER BY LastName, FirstName"
    )
    return _records(sf.query_all(soql))


def fetch_opportunities(sf: Salesforce, account_id: str) -> List[Dict[str, Any]]:
    soql = (
        "SELECT Id, Name, StageName, Amount, Probability, CloseDate, "
        "Type, LeadSource, NextStep, ForecastCategory, IsClosed, IsWon, "
        "OwnerId, Owner.Name, AccountId, RecordTypeId, RecordType.Name, "
        "Description, CreatedDate, CreatedById, LastModifiedDate, "
        "LastActivityDate, FiscalYear, FiscalQuarter "
        f"FROM Opportunity WHERE AccountId = '{account_id}' "
        "AND IsDeleted = false ORDER BY CloseDate DESC NULLS LAST"
    )
    return _records(sf.query_all(soql))


def fetch_opp_stage_history(sf: Salesforce, opp_ids: Iterable[str]) -> List[Dict[str, Any]]:
    ids = list(opp_ids)
    if not ids:
        return []
    in_clause = ", ".join(f"'{i}'" for i in ids)
    soql = (
        "SELECT OpportunityId, Field, OldValue, NewValue, CreatedDate, "
        "CreatedById, CreatedBy.Name "
        f"FROM OpportunityFieldHistory WHERE OpportunityId IN ({in_clause}) "
        "ORDER BY CreatedDate DESC"
    )
    return _records(sf.query_all(soql))


def fetch_tasks(sf: Salesforce, parent_ids: Iterable[str]) -> List[Dict[str, Any]]:
    ids = list(parent_ids)
    if not ids:
        return []
    in_clause = ", ".join(f"'{i}'" for i in ids)
    soql = (
        "SELECT Id, Subject, Status, Priority, ActivityDate, "
        "Description, OwnerId, Owner.Name, WhoId, Who.Name, WhatId, "
        "What.Name, IsClosed, CallType, CompletedDateTime, CreatedDate, "
        "CreatedById, CreatedBy.Name, LastModifiedDate "
        f"FROM Task WHERE WhatId IN ({in_clause}) "
        "ORDER BY ActivityDate DESC NULLS LAST, CreatedDate DESC"
    )
    return _records(sf.query_all(soql))


def fetch_events(sf: Salesforce, parent_ids: Iterable[str]) -> List[Dict[str, Any]]:
    ids = list(parent_ids)
    if not ids:
        return []
    in_clause = ", ".join(f"'{i}'" for i in ids)
    soql = (
        "SELECT Id, Subject, Description, Location, ActivityDate, "
        "ActivityDateTime, DurationInMinutes, EndDateTime, IsAllDayEvent, "
        "OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name, "
        "Type, CreatedDate, CreatedById, CreatedBy.Name, LastModifiedDate "
        f"FROM Event WHERE WhatId IN ({in_clause}) "
        "ORDER BY ActivityDate DESC NULLS LAST"
    )
    return _records(sf.query_all(soql))


def fetch_notes(sf: Salesforce, parent_ids: Iterable[str]) -> List[Dict[str, Any]]:
    """Pull ContentNote via ContentDocumentLink for the given parents."""
    ids = list(parent_ids)
    if not ids:
        return []
    in_clause = ", ".join(f"'{i}'" for i in ids)
    soql = (
        "SELECT LinkedEntityId, ContentDocumentId, "
        "ContentDocument.Title, ContentDocument.LatestPublishedVersion.TextPreview, "
        "ContentDocument.CreatedDate, ContentDocument.CreatedBy.Name "
        f"FROM ContentDocumentLink WHERE LinkedEntityId IN ({in_clause}) "
        "ORDER BY ContentDocument.CreatedDate DESC"
    )
    try:
        return _records(sf.query_all(soql))
    except Exception:
        return []  # silently skip; not all orgs grant access to notes


# ── Markdown rendering ────────────────────────────────────────────────────


def _md_escape(text: Any) -> str:
    if text is None:
        return ""
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def _h(level: int, text: str) -> str:
    return f"{'#' * level} {text}\n\n"


def _row(*cells: Any) -> str:
    return "| " + " | ".join(_md_escape(c) for c in cells) + " |\n"


def _table(headers: List[str], rows: Iterable[List[Any]]) -> str:
    out = _row(*headers)
    out += "| " + " | ".join("---" for _ in headers) + " |\n"
    for r in rows:
        out += _row(*r)
    return out + "\n"


def render_account(
    sf: Salesforce,
    account: Dict[str, Any],
) -> str:
    a = _strip_attrs(account)
    aid = a["Id"]
    md: List[str] = []

    md.append(_h(2, f"Account: {a.get('Name')}"))
    md.append(f"**SF Id:** `{aid}`  \n")
    if (rt := a.get("RecordType")) and rt:
        md.append(f"**Record type:** {rt.get('Name')}  \n")
    if a.get("Type"):
        md.append(f"**Type:** {a.get('Type')}  \n")
    if a.get("Industry"):
        md.append(f"**Industry:** {a.get('Industry')}  \n")
    if a.get("Website"):
        md.append(f"**Website:** {a.get('Website')}  \n")
    if a.get("Phone"):
        md.append(f"**Phone:** {a.get('Phone')}  \n")
    addr_parts = [
        a.get("BillingCity"),
        a.get("BillingState"),
        a.get("BillingCountry"),
    ]
    addr = ", ".join(p for p in addr_parts if p)
    if addr:
        md.append(f"**Billing:** {addr}  \n")
    if a.get("AnnualRevenue"):
        md.append(f"**Annual revenue:** {a.get('AnnualRevenue')}  \n")
    if a.get("NumberOfEmployees"):
        md.append(f"**Employees:** {a.get('NumberOfEmployees')}  \n")
    if (owner := a.get("Owner")):
        md.append(f"**Owner:** {owner.get('Name')}  \n")
    md.append(f"**Created:** {a.get('CreatedDate')}  \n")
    md.append(f"**Last modified:** {a.get('LastModifiedDate')}  \n")
    md.append(f"**Last activity:** {a.get('LastActivityDate') or '—'}  \n\n")
    if a.get("Description"):
        md.append(f"**Description:**  \n> {a['Description']}\n\n")

    # Contacts
    contacts = fetch_contacts(sf, aid)
    md.append(_h(3, f"Contacts ({len(contacts)})"))
    if contacts:
        md.append(_table(
            ["Name", "Title", "Email", "Phone", "Owner", "Last activity"],
            [
                [
                    " ".join(p for p in [c.get("FirstName"), c.get("LastName")] if p),
                    c.get("Title"),
                    c.get("Email"),
                    c.get("Phone") or c.get("MobilePhone"),
                    (c.get("Owner") or {}).get("Name"),
                    c.get("LastActivityDate"),
                ]
                for c in contacts
            ],
        ))
    else:
        md.append("_None._\n\n")

    # Opportunities
    opps = fetch_opportunities(sf, aid)
    md.append(_h(3, f"Opportunities ({len(opps)})"))
    if opps:
        md.append(_table(
            ["Name", "Stage", "Amount", "Close date", "Record type", "Owner", "Won?", "Created"],
            [
                [
                    o.get("Name"),
                    o.get("StageName"),
                    o.get("Amount"),
                    o.get("CloseDate"),
                    (o.get("RecordType") or {}).get("Name"),
                    (o.get("Owner") or {}).get("Name"),
                    "✓" if o.get("IsWon") else ("✗" if o.get("IsClosed") else ""),
                    (o.get("CreatedDate") or "")[:10],
                ]
                for o in opps
            ],
        ))

        # Per-opp detail
        for o in opps:
            md.append(_h(4, f"Opp · {o.get('Name')}"))
            md.append(f"**SF Id:** `{o.get('Id')}`  \n")
            md.append(f"**Stage:** {o.get('StageName')} ({o.get('Probability')}%)  \n")
            md.append(f"**Amount:** {o.get('Amount')}  \n")
            md.append(f"**Close date:** {o.get('CloseDate')}  \n")
            if (rt := o.get("RecordType")) and rt:
                md.append(f"**Record type:** {rt.get('Name')}  \n")
            if o.get("NextStep"):
                md.append(f"**Next step:** {o.get('NextStep')}  \n")
            if o.get("Description"):
                md.append(f"**Description:**  \n> {o.get('Description')}\n\n")

        # Stage history (single batch query for all opps)
        history = fetch_opp_stage_history(sf, [o["Id"] for o in opps])
        md.append(_h(4, f"Stage history ({len(history)} events)"))
        if history:
            opp_name = {o["Id"]: o.get("Name") for o in opps}
            md.append(_table(
                ["When", "Opp", "Field", "From", "To", "By"],
                [
                    [
                        (h.get("CreatedDate") or "")[:19].replace("T", " "),
                        opp_name.get(h.get("OpportunityId"), h.get("OpportunityId")),
                        h.get("Field"),
                        h.get("OldValue"),
                        h.get("NewValue"),
                        (h.get("CreatedBy") or {}).get("Name"),
                    ]
                    for h in history
                ],
            ))
        else:
            md.append("_No stage-history rows visible (org may not surface OpportunityFieldHistory)._\n\n")
    else:
        md.append("_None._\n\n")

    # Activities — Tasks + Events on Account and on each Opp
    parent_ids = [aid] + [o["Id"] for o in opps]
    tasks = fetch_tasks(sf, parent_ids)
    md.append(_h(3, f"Tasks ({len(tasks)})"))
    if tasks:
        md.append(_table(
            ["Date", "Subject", "Status", "Owner", "Re:", "Who"],
            [
                [
                    t.get("ActivityDate") or (t.get("CreatedDate") or "")[:10],
                    t.get("Subject"),
                    t.get("Status"),
                    (t.get("Owner") or {}).get("Name"),
                    (t.get("What") or {}).get("Name"),
                    (t.get("Who") or {}).get("Name"),
                ]
                for t in tasks
            ],
        ))
    else:
        md.append("_None._\n\n")

    events = fetch_events(sf, parent_ids)
    md.append(_h(3, f"Events ({len(events)})"))
    if events:
        md.append(_table(
            ["Date", "Subject", "Type", "Owner", "Re:", "Location"],
            [
                [
                    e.get("ActivityDate") or e.get("ActivityDateTime"),
                    e.get("Subject"),
                    e.get("Type"),
                    (e.get("Owner") or {}).get("Name"),
                    (e.get("What") or {}).get("Name"),
                    e.get("Location"),
                ]
                for e in events
            ],
        ))
    else:
        md.append("_None._\n\n")

    notes = fetch_notes(sf, parent_ids)
    md.append(_h(3, f"Notes / Files ({len(notes)})"))
    if notes:
        md.append(_table(
            ["Title", "Created", "By", "Re:", "Preview"],
            [
                [
                    (n.get("ContentDocument") or {}).get("Title"),
                    ((n.get("ContentDocument") or {}).get("CreatedDate") or "")[:10],
                    ((n.get("ContentDocument") or {}).get("CreatedBy") or {}).get("Name"),
                    n.get("LinkedEntityId"),
                    ((n.get("ContentDocument") or {})
                        .get("LatestPublishedVersion") or {}).get("TextPreview"),
                ]
                for n in notes
            ],
        ))
    else:
        md.append("_None or no access._\n\n")

    return "".join(md)


# ── Entrypoint ────────────────────────────────────────────────────────────


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", help="Account name fragment, e.g. 'Con Ed' or 'Con Edison'")
    parser.add_argument("--out", default=None,
                        help="Output markdown path (default: <query-slug>-dump.md)")
    args = parser.parse_args(argv)

    sf = _build_sf_client()
    accounts = find_accounts(sf, args.query)

    if not accounts:
        print(f"No accounts matched LIKE '%{args.query}%'.", file=sys.stderr)
        return 2

    out_path = args.out
    if out_path is None:
        slug = (
            args.query.lower()
            .replace(" ", "-")
            .replace("/", "-")
        )
        out_path = f"{slug}-dump.md"

    md: List[str] = []
    md.append(_h(1, f"Salesforce dump — query: '{args.query}'"))
    md.append(f"**Generated:** {datetime.utcnow().isoformat(timespec='seconds')}Z  \n")
    md.append(f"**Matched accounts:** {len(accounts)}  \n\n")

    for account in accounts:
        md.append(render_account(sf, account))
        md.append("\n---\n\n")

    Path(out_path).write_text("".join(md))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
