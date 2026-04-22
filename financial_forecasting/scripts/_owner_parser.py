"""Owner-string parser shared by the AIJI importer and the migration script.

Parses free-text owner fields like `"Laura / Johnny / External Support TBD / Dave (?)"`
into a list of UUIDs (matched active users) plus a residual "Other" TEXT containing
only the unmatched tokens. `(?)` uncertainty markers are stripped before matching
so `Dave (?)` cleanly resolves to `Dave Yang`.

Split separators: `/`, `+`, `,`.
No other morphological normalization — keep it predictable and inspectable.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List, Tuple

_SPLIT_RE = re.compile(r"\s*[/+,]\s*")
_UNCERTAINTY_RE = re.compile(r"\s*\(\?\)\s*")


def _normalize(s: Any) -> str:
    return (str(s) if s is not None else "").strip().lower()


def build_user_map(rows: List[Dict[str, Any]]) -> Dict[str, uuid.UUID]:
    """Build {token -> uuid.UUID} from `public.org_users` rows.

    Keys include the full display_name (lowercased) plus the first name for any
    user whose first name is unambiguous across the whole active roster.
    """
    by_full: Dict[str, uuid.UUID] = {}
    first_counts: Dict[str, int] = {}
    first_map: Dict[str, uuid.UUID] = {}

    for row in rows:
        name = (row.get("display_name") or "").strip()
        if not name:
            continue
        uid = row["id"]
        if isinstance(uid, str):
            uid = uuid.UUID(uid)
        by_full[_normalize(name)] = uid
        first_tok = name.split()[0].lower()
        first_counts[first_tok] = first_counts.get(first_tok, 0) + 1
        first_map[first_tok] = uid

    combined: Dict[str, uuid.UUID] = dict(by_full)
    for first, uid in first_map.items():
        if first_counts.get(first, 0) == 1:
            combined.setdefault(first, uid)
    return combined


def _strip_uncertainty(token: str) -> str:
    """Remove `(?)` markers. Keep other punctuation — we don't want `Dave (something else)` to quietly resolve."""
    return _UNCERTAINTY_RE.sub("", token or "").strip()


def parse_owner_string(
    raw: Any,
    user_map: Dict[str, uuid.UUID],
) -> Tuple[List[uuid.UUID], str]:
    """Return (owner_ids, other_text) for a single raw owner string.

    owner_ids preserves first-seen order and deduplicates.
    other_text is the unmatched tokens rejoined by ` / ` — original tokens are
    preserved (we don't strip the `(?)` we used for matching, on the theory
    that an unmatched `Dave (something weird)` is a better audit trail than
    `Dave something weird`).
    """
    s = (str(raw) if raw is not None else "").strip()
    if not s:
        return [], ""
    tokens = [t.strip() for t in _SPLIT_RE.split(s) if t.strip()]
    owner_ids: List[uuid.UUID] = []
    seen: set = set()
    other: List[str] = []
    for tok in tokens:
        key = _normalize(_strip_uncertainty(tok))
        uid = user_map.get(key)
        if uid is not None:
            if uid not in seen:
                owner_ids.append(uid)
                seen.add(uid)
        else:
            other.append(tok)
    return owner_ids, " / ".join(other)
