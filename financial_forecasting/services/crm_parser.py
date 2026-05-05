"""CRM message parsing and entity resolution for automation review pipeline."""

import re
import difflib
import calendar as _calendar
from datetime import date, timedelta
from typing import Any, Dict, List, Optional


# Module-level opportunity cache for entity resolution
_opp_cache: List[Dict[str, Any]] = []
_opp_cache_loaded: bool = False


def get_opp_cache(client=None) -> List[Dict[str, Any]]:
    """Return cached opportunity list; populate from SF on first call."""
    global _opp_cache, _opp_cache_loaded
    if _opp_cache_loaded:
        return _opp_cache
    return _opp_cache


def refresh_opp_cache(opportunities: List[Dict[str, Any]]) -> None:
    """Refresh the opportunity cache from a list of opportunity dicts."""
    global _opp_cache, _opp_cache_loaded
    _opp_cache = opportunities
    _opp_cache_loaded = True


def extract_amount(text: str) -> Optional[int]:
    """Extract dollar amount from text like $250K, $1.2M, $100,000."""
    match = re.search(r'\$[\d,]+(?:\.\d+)?[KkMm]?', text)
    if not match:
        return None
    raw = match.group(0).replace('$', '').replace(',', '')
    multiplier = 1
    if raw[-1] in ('K', 'k'):
        multiplier = 1_000
        raw = raw[:-1]
    elif raw[-1] in ('M', 'm'):
        multiplier = 1_000_000
        raw = raw[:-1]
    try:
        return int(float(raw) * multiplier)
    except ValueError:
        return None


def extract_close_date(text: str) -> Optional[str]:
    """Extract a close date from natural language text. Returns ISO date string."""
    text_lower = text.lower()
    today = date.today()

    # "end of [month]"
    m = re.search(r'end of (\w+)', text_lower)
    if m:
        month_name = m.group(1).capitalize()
        for i, name in enumerate(_calendar.month_name):
            if name and name.lower().startswith(month_name.lower()):
                year = today.year if i >= today.month else today.year + 1
                last_day = _calendar.monthrange(year, i)[1]
                return date(year, i, last_day).isoformat()

    # "by Q[1-4]"
    m = re.search(r'by q([1-4])', text_lower)
    if m:
        q = int(m.group(1))
        end_month = q * 3
        year = today.year if end_month >= today.month else today.year + 1
        last_day = _calendar.monthrange(year, end_month)[1]
        return date(year, end_month, last_day).isoformat()

    # "[month] [day]" e.g. "April 15"
    m = re.search(r'(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\s+(\d{1,2})\b', text_lower)
    if m:
        month_name = m.group(1).capitalize()
        day_num = int(m.group(2))
        for i, name in enumerate(_calendar.month_name):
            if name and name.lower().startswith(month_name.lower()):
                year = today.year if i > today.month or (i == today.month and day_num >= today.day) else today.year + 1
                try:
                    return date(year, i, day_num).isoformat()
                except ValueError:
                    pass

    # "next [weekday]"
    weekdays = {'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3, 'friday': 4, 'saturday': 5, 'sunday': 6}
    m = re.search(r'next (\w+day)', text_lower)
    if m and m.group(1) in weekdays:
        target = weekdays[m.group(1)]
        days_ahead = target - today.weekday()
        if days_ahead <= 0:
            days_ahead += 7
        return (today + timedelta(days=days_ahead)).isoformat()

    return None


def fuzzy_match_opportunity(text: str, opportunities: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Find the best-matching opportunity by name or account name using fuzzy matching."""
    if not opportunities:
        return None
    text_lower = text.lower()
    best_match = None
    best_ratio = 0.0

    for opp in opportunities:
        for field in [opp.get("Name", ""), (opp.get("Account") or {}).get("Name", "")]:
            if not field:
                continue
            ratio = difflib.SequenceMatcher(None, text_lower, field.lower()).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_match = opp
            # Also check if the name appears as substring
            if field.lower() in text_lower and len(field) > 3:
                sub_ratio = max(ratio, 0.65)
                if sub_ratio > best_ratio:
                    best_ratio = sub_ratio
                    best_match = opp

    if best_ratio > 0.6 and best_match:
        return best_match
    return None


def parse_crm_message(text: str, opportunities: List[Dict] = None) -> Dict[str, Any]:
    """NLP-style parser for CRM update messages.

    Extracts: opportunity reference, action type (note, stage_change, task),
    details, amount, and close date.
    """
    text_lower = text.lower()
    parsed: Dict[str, Any] = {
        "action": "note",
        "detail": text,
        "confidence": 0.5,
        "matched_opportunity": None,
        "stage": None,
        "amount": None,
        "close_date": None,
    }

    # Detect stage changes
    stage_keywords = {
        "qualifying": "Qualifying",
        "qualified": "Qualifying",
        "proposal": "Ask in Progress",
        "negotiat": "Proposal Submitted",
        "contract": "Contract Creation",
        "closed won": "Closed / Completed",
        "closed lost": "Closed Lost",
        "withdrawn": "Withdrawn",
        "collecting": "Collecting / In Effect",
    }
    for keyword, stage in stage_keywords.items():
        if keyword in text_lower:
            parsed["action"] = "stage_change"
            parsed["stage"] = stage
            parsed["confidence"] = 0.7
            break

    # Detect task creation
    task_keywords = ["follow up", "schedule", "send", "call", "email", "prepare", "set up", "next step"]
    for kw in task_keywords:
        if kw in text_lower:
            if parsed["action"] == "note":
                parsed["action"] = "task"
                parsed["confidence"] = 0.6
            break

    # Entity resolution — fuzzy match against known opportunities
    opp_list = opportunities or get_opp_cache()
    matched = fuzzy_match_opportunity(text, opp_list)
    if matched:
        parsed["matched_opportunity"] = matched.get("Id")
        parsed["confidence"] = min(parsed["confidence"] + 0.15, 0.95)

    # Amount extraction
    amount = extract_amount(text)
    if amount is not None:
        parsed["amount"] = amount

    # Date extraction
    close_date = extract_close_date(text)
    if close_date:
        parsed["close_date"] = close_date

    return parsed
