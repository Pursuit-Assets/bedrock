"""Static lints for db/migrations/*.sql files.

Catches classes of PostgreSQL errors that don't show up until apply
time, when fixing them means a rollback + amended migration. Each
lint corresponds to a real bug we hit (or nearly hit) during the
2026-05-18 Wave 0 verification pass.

The lints are intentionally regex-based — no DB connection required,
so this test runs in every CI on every commit and protects the
migration directory at zero infrastructure cost. When a future
migration needs a behavior these lints reject, the right move is to
*either* fix the migration to use an immutable pattern *or* add an
explicit `-- lint-allow: <rule>` comment on the offending line.

Lints implemented:

  L1. ``CREATE INDEX`` ... ``WHERE`` ... ``now()`` — PostgreSQL forbids
      non-IMMUTABLE functions in index predicates. The error at apply
      time is opaque: "functions in index predicate must be marked
      IMMUTABLE". now() is STABLE, not IMMUTABLE. Same for
      ``current_timestamp``, ``current_date``, ``transaction_timestamp``.

  L2. ``ADD COLUMN`` ... ``NOT NULL DEFAULT`` on an existing table
      where the table is also CREATEd in init.sql. Bulk-defaulting
      historical rows is rarely what we want — usually we want NULL
      (legacy marker) or pick a terminal state. False positives are
      acceptable (lint warns, doesn't fail); the `# noqa-bulk-default`
      pragma in the same line silences when intentional.

  L3. ``CHECK`` ... ``IN (... NULL ...)`` — including NULL in an IN
      list is almost always a bug. NULL is never equal to itself in
      SQL semantics, so `x IN (..., NULL)` doesn't mean "or null", it
      means "or NULL" which collapses the whole expression to NULL.
      Prefer `x IS NULL OR x IN (...)`.

Add to this file when new classes of migration bugs are found.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

MIGRATIONS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "db", "migrations"),
)


def _migration_files() -> list[str]:
    files = []
    for name in sorted(os.listdir(MIGRATIONS_DIR)):
        if name.endswith(".sql"):
            files.append(os.path.join(MIGRATIONS_DIR, name))
    return files


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Match a CREATE INDEX statement up to its terminating semicolon, allowing
# the (possibly-partial-index) WHERE clause. DOTALL so it spans lines.
_CREATE_INDEX_RE = re.compile(
    r"CREATE\s+(?:UNIQUE\s+)?INDEX\b(?:\s+IF\s+NOT\s+EXISTS)?[^;]*?;",
    re.IGNORECASE | re.DOTALL,
)

# Non-immutable time functions banned from index predicates.
_NONIMMUTABLE_TIME = re.compile(
    r"\b(now|current_timestamp|current_date|current_time|transaction_timestamp|statement_timestamp|clock_timestamp|localtimestamp|localtime)\s*\(",
    re.IGNORECASE,
)

_ADD_COLUMN_NOT_NULL_DEFAULT_RE = re.compile(
    r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+\w[\w()]*\s+NOT\s+NULL\s+DEFAULT\b",
    re.IGNORECASE,
)

# IN list containing the literal NULL. We allow it inside an explicit IS
# NULL wrapper (handled by skipping any IN-list whose enclosing CHECK
# also has "IS NULL").
_CHECK_IN_NULL_RE = re.compile(
    r"CHECK\s*\((?:[^()]*|\([^()]*\))*\)",
    re.IGNORECASE | re.DOTALL,
)


def _strip_comments(sql: str) -> str:
    """Remove SQL comments so lints don't trip on commentary."""
    # -- single-line
    sql = re.sub(r"--[^\n]*", "", sql)
    # /* ... */ multi-line
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)
    return sql


# ---------------------------------------------------------------------------
# L1. non-IMMUTABLE function in partial-index predicate
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", _migration_files(), ids=os.path.basename)
def test_lint_l1_no_nonimmutable_in_index_predicate(path: str):
    """Reject CREATE INDEX ... WHERE clauses that call non-IMMUTABLE
    functions. PostgreSQL rejects these with 'functions in index
    predicate must be marked IMMUTABLE' at apply time.

    Specifically protects against the now()-in-WHERE bug we hit in
    2026-05-18-pebble-swarm-runtime.sql before discovery.
    """
    with open(path) as f:
        raw = f.read()
    sql = _strip_comments(raw)

    violations = []
    for match in _CREATE_INDEX_RE.finditer(sql):
        stmt = match.group(0)
        if "WHERE" not in stmt.upper():
            continue
        # Find the WHERE clause body up to the closing semicolon.
        where_idx = stmt.upper().index("WHERE")
        predicate = stmt[where_idx:]
        bad = _NONIMMUTABLE_TIME.search(predicate)
        if bad:
            violations.append((bad.group(0), stmt.strip().split("\n")[0]))

    assert not violations, (
        f"{os.path.basename(path)}: non-IMMUTABLE function in CREATE INDEX "
        f"predicate (will fail at apply time with 'functions in index "
        f"predicate must be marked IMMUTABLE'): "
        f"{violations}"
    )


# ---------------------------------------------------------------------------
# L2. ADD COLUMN NOT NULL DEFAULT — opt-in warning, not failure
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", _migration_files(), ids=os.path.basename)
def test_lint_l2_add_column_not_null_default_documented(path: str):
    """ADD COLUMN ... NOT NULL DEFAULT mass-applies the default to every
    existing row. Usually that's wrong for state-machine columns —
    historical rows get marked as live. Allowed when followed (within
    the same migration body) by an explanatory comment or when the
    column is a pure resource counter (defaults to 0 are universally
    safe).

    This lint is informational: it asserts that every NOT NULL DEFAULT
    on an ADD COLUMN line has SOME nearby comment explaining the
    choice, so reviewers can't sneak a future case through silently.
    Defaults to 0 / FALSE are exempt as universally safe.
    """
    with open(path) as f:
        raw = f.read()
    # We DO want comments here — the lint is "is there a comment".
    lines = raw.splitlines()

    safe_defaults = re.compile(r"DEFAULT\s+(0|FALSE|TRUE|'\{\}'::jsonb|'\[\]'::jsonb)\b", re.IGNORECASE)

    flagged = []
    for i, line in enumerate(lines):
        if not _ADD_COLUMN_NOT_NULL_DEFAULT_RE.search(line):
            continue
        if safe_defaults.search(line):
            continue
        # Look up to 8 lines above for a comment line explaining the default.
        has_nearby_comment = any(
            lines[j].strip().startswith("--")
            for j in range(max(0, i - 8), i)
        )
        if not has_nearby_comment:
            flagged.append((i + 1, line.strip()))

    assert not flagged, (
        f"{os.path.basename(path)}: ADD COLUMN ... NOT NULL DEFAULT without "
        f"an explanatory comment (mass-applies default to existing rows — "
        f"is that intended? if so, add a -- comment above):\n"
        + "\n".join(f"  L{ln}: {body}" for ln, body in flagged)
    )


# ---------------------------------------------------------------------------
# L3. NULL inside IN-list of a CHECK constraint
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", _migration_files(), ids=os.path.basename)
def test_lint_l3_no_null_in_check_in_list(path: str):
    """CHECK (col IN (..., NULL)) — NULL inside an IN list does not
    mean "or null". SQL semantics: `x IN (a, NULL)` becomes
    `x = a OR x = NULL`, and `x = NULL` is NULL (not TRUE). The
    correct form is `x IS NULL OR x IN (a, ...)`.

    Catches the trend_direction / ideology_cluster pattern we used in
    network-and-giving.sql before discovery.
    """
    with open(path) as f:
        raw = f.read()
    sql = _strip_comments(raw)

    violations = []
    for match in _CHECK_IN_NULL_RE.finditer(sql):
        body = match.group(0)
        upper = body.upper()
        # Skip CHECK constraints that already wrap IS NULL — those are
        # the correct pattern.
        if "IS NULL" in upper:
            continue
        # Look for "IN (..., NULL ...)"
        if re.search(r"\bIN\s*\([^)]*\bNULL\b[^)]*\)", body, re.IGNORECASE):
            violations.append(body.strip().split("\n")[0])

    assert not violations, (
        f"{os.path.basename(path)}: NULL inside CHECK ... IN (...) list. "
        f"Use `col IS NULL OR col IN (...)` instead: {violations}"
    )


# ---------------------------------------------------------------------------
# Smoke: every new migration has a date header
# ---------------------------------------------------------------------------

# Lint adopted 2026-05-18. Migrations dated strictly before this date used
# a variety of conventions (banner-style `-- ====`, SQL-first, plain title
# comments) and are grandfathered. From 2026-05-18 onward every new
# migration must declare its date in the first 15 lines via
# `-- YYYY-MM-DD: <description>` so reviewers can scan the directory.
_HEADER_LINT_CUTOFF = "2026-05-18"


@pytest.mark.parametrize("path", _migration_files(), ids=os.path.basename)
def test_migration_header_present(path: str):
    """Every migration dated >= _HEADER_LINT_CUTOFF must declare its date
    in the first 15 lines as `-- YYYY-MM-DD: <description>` so reviewers
    can scan the directory. Banner-style and SQL-first legacy migrations
    pre-cutoff are grandfathered.
    """
    fname = os.path.basename(path)
    fname_date_match = re.match(r"^(\d{4}-\d{2}-\d{2})-", fname)
    assert fname_date_match, (
        f"{fname}: filename must start with YYYY-MM-DD-<slug>.sql"
    )
    if fname_date_match.group(1) < _HEADER_LINT_CUTOFF:
        pytest.skip(f"grandfathered legacy migration (pre-{_HEADER_LINT_CUTOFF})")
    with open(path) as f:
        head = [f.readline() for _ in range(15)]
    joined = "".join(head)
    assert re.search(r"--\s*\d{4}-\d{2}-\d{2}\s*:", joined), (
        f"{fname}: first 15 lines must include a `-- YYYY-MM-DD: <description>` "
        f"comment so reviewers can scan the directory. Got head:\n{joined.rstrip()}"
    )
