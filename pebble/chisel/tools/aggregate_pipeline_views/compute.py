"""Pure-Python aggregations for the weekly pipeline review.

No I/O — these functions take SF opportunity dicts and emit chart-ready
rows. Easy to unit test in isolation; handler.py is the only consumer.

Stage classification: anything NOT matching the closed-marker set
counts as active. Safer than an allowlist — new SF stages added later
default to active rather than vanishing from the views (per memory
``feedback_sf_stages_sacred``).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from uuid import uuid4


DEFAULT_AT_RISK_DAYS_TO_CLOSE = 30
DEFAULT_STALE_DAYS_NO_ACTIVITY = 60
DEFAULT_TOP_N_COVERAGE = 10


_CLOSED_STAGE_MARKERS: frozenset[str] = frozenset({
    "closed won",
    "closed lost",
    "closed completed",
    "closed / completed",
    "closed / fulfilled",
    "lost",
})


def is_closed_stage(stage: Optional[str]) -> bool:
    if not stage:
        return False
    s = stage.strip().lower()
    return any(marker in s for marker in _CLOSED_STAGE_MARKERS)


def _parse_date(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def opp_amount(opp: dict[str, Any]) -> float:
    raw = opp.get("Amount")
    if raw is None:
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def opp_owner_label(opp: dict[str, Any]) -> str:
    """Owner identifier — email preferred (stable), fallback to name,
    finally ``(unassigned)`` so the coverage chart has a bucket."""
    owner = opp.get("Owner")
    if isinstance(owner, dict):
        email = owner.get("Email") or owner.get("email")
        if email:
            return str(email)
        name = owner.get("Name") or owner.get("name")
        if name:
            return str(name)
    if opp.get("OwnerEmail"):
        return str(opp["OwnerEmail"])
    if opp.get("Owner__Email"):
        return str(opp["Owner__Email"])
    return "(unassigned)"


def account_name(opp: dict[str, Any]) -> str:
    acct = opp.get("Account")
    if isinstance(acct, dict):
        n = acct.get("Name") or acct.get("name")
        if n:
            return str(n)
    if opp.get("AccountName"):
        return str(opp["AccountName"])
    return ""


def compute_at_risk(
    opps: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
    days_to_close: int = DEFAULT_AT_RISK_DAYS_TO_CLOSE,
) -> list[dict[str, Any]]:
    """Open opps with close date inside ``days_to_close`` from today,
    sorted by closest first. Row shape matches Recharts data array."""
    today = today or datetime.now(tz=timezone.utc).date()
    horizon = today + timedelta(days=days_to_close)

    out: list[dict[str, Any]] = []
    for opp in opps or []:
        if is_closed_stage(opp.get("StageName")):
            continue
        cd = _parse_date(opp.get("CloseDate"))
        if cd is None or cd < today or cd > horizon:
            continue
        out.append({
            "name": str(opp.get("Name") or "(unnamed)")[:80],
            "account": account_name(opp),
            "owner": opp_owner_label(opp),
            "amount": opp_amount(opp),
            "stage": str(opp.get("StageName") or ""),
            "close_date": cd.isoformat(),
            "days_to_close": (cd - today).days,
            "id": str(opp.get("Id") or ""),
        })
    out.sort(key=lambda r: r["days_to_close"])
    return out


def compute_stale(
    opps: list[dict[str, Any]],
    *,
    today: Optional[date] = None,
    days_no_activity: int = DEFAULT_STALE_DAYS_NO_ACTIVITY,
) -> list[dict[str, Any]]:
    """Open opps with no recent activity in ``days_no_activity`` days.
    Missing ``LastActivityDate`` counts as effectively oldest."""
    today = today or datetime.now(tz=timezone.utc).date()
    cutoff = today - timedelta(days=days_no_activity)

    out: list[dict[str, Any]] = []
    for opp in opps or []:
        if is_closed_stage(opp.get("StageName")):
            continue
        last = _parse_date(opp.get("LastActivityDate"))
        if last is not None and last >= cutoff:
            continue
        days_since = (today - last).days if last else None
        out.append({
            "name": str(opp.get("Name") or "(unnamed)")[:80],
            "account": account_name(opp),
            "owner": opp_owner_label(opp),
            "amount": opp_amount(opp),
            "stage": str(opp.get("StageName") or ""),
            "last_activity_date": last.isoformat() if last else None,
            "days_since_activity": days_since,
            "id": str(opp.get("Id") or ""),
        })
    out.sort(
        key=lambda r: r["days_since_activity"] if r["days_since_activity"] is not None else 10**6,
        reverse=True,
    )
    return out


def compute_coverage(
    opps: list[dict[str, Any]],
    *,
    top_n: int = DEFAULT_TOP_N_COVERAGE,
) -> list[dict[str, Any]]:
    """sum(open amount) by owner, descending, top N. Excludes closed."""
    by_owner: dict[str, dict[str, Any]] = {}
    for opp in opps or []:
        if is_closed_stage(opp.get("StageName")):
            continue
        owner = opp_owner_label(opp)
        bucket = by_owner.setdefault(owner, {"owner": owner, "amount": 0.0, "count": 0})
        bucket["amount"] += opp_amount(opp)
        bucket["count"] += 1
    rows = sorted(by_owner.values(), key=lambda r: r["amount"], reverse=True)
    return rows[:top_n]


def chart_spec(
    *, kind: str, title: str, data: list[dict[str, Any]],
    x_key: str, y_keys: list[str],
) -> dict[str, Any]:
    """Same shape as ``schemas.ChartSpec`` and ``generate_chart``'s
    output. Inlined here so this workflow doesn't have to round-trip
    through generate_chart for every chart — we already have the data
    aggregated."""
    return {
        "chart_id": str(uuid4()),
        "kind": kind,
        "title": title,
        "data": data,
        "x_key": x_key,
        "y_keys": y_keys,
    }
