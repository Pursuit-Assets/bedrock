"""Replace AIJI project's workstreams + milestones from the CSV at
~/Downloads/AIJI workstreams and milestones - Milestones.csv.

This is intentionally a one-off script — run from the financial_forecasting
directory with the venv activated:

    cd ~/dev/build/bedrock/financial_forecasting
    source .venv/bin/activate
    python scripts/seed_aiji_workstreams.py

It will:
  1. Look up the AIJI project (case-insensitive match on name).
  2. Soft-delete all existing workstreams (cascading to milestones + tasks).
  3. Insert 5 new workstreams in the order they appear in the CSV.
  4. Insert 14 milestones with status, due_date (end of last month in
     2026 for the timeline range), description, owner (if a single active
     user matches), and source_links (parsed from the Source column).

A confirmation prompt is shown before any destructive write.
"""
from __future__ import annotations

import asyncio
import csv
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import asyncpg
from dotenv import load_dotenv


BEDROCK_ROOT = Path("/Users/jacquelinereverand/dev/build/bedrock")
_MILESTONES_NAME = "AIJI workstreams and milestones - Milestones.csv"
_TASKS_NAME = "AIJI workstreams and milestones - Tasks.csv"

# Prefer the repo copy (no macOS Privacy sandbox); fall back to Downloads.
CSV_PATH = next(
    (p for p in (BEDROCK_ROOT / _MILESTONES_NAME, Path.home() / "Downloads" / _MILESTONES_NAME) if p.exists()),
    BEDROCK_ROOT / _MILESTONES_NAME,
)
TASKS_CSV_PATH = next(
    (p for p in (BEDROCK_ROOT / _TASKS_NAME, Path.home() / "Downloads" / _TASKS_NAME) if p.exists()),
    BEDROCK_ROOT / _TASKS_NAME,
)

# Map "Aug - Sept" / "Apr - May" style timeline strings to a due_date.
# Falls back to None if unparseable.
MONTH_TO_LAST_DAY_2026: dict[str, date] = {
    "jan": date(2026, 1, 31),
    "feb": date(2026, 2, 28),
    "mar": date(2026, 3, 31),
    "apr": date(2026, 4, 30),
    "may": date(2026, 5, 31),
    "jun": date(2026, 6, 30),
    "jul": date(2026, 7, 31),
    "aug": date(2026, 8, 31),
    "sep": date(2026, 9, 30),
    "oct": date(2026, 10, 31),
    "nov": date(2026, 11, 30),
    "dec": date(2026, 12, 31),
}


def parse_timeline(s: str) -> Optional[date]:
    """'Aug - Sept' -> 2026-09-30. Uses the END of the LAST month."""
    if not s:
        return None
    parts = re.split(r"\s*[-–—]\s*", s.strip())
    last = parts[-1].strip().lower()[:3]
    return MONTH_TO_LAST_DAY_2026.get(last)


def parse_source_links(raw: str) -> list[str]:
    if not raw:
        return []
    # CSV cells sometimes embed multiple URLs separated by newlines.
    return [line.strip() for line in raw.splitlines() if line.strip().startswith("http")]


def normalize_status(s: str) -> str:
    l = (s or "").strip().lower()
    if l == "on track":
        return "On Track"
    if l == "not started":
        return "Not Started"
    if l == "at risk":
        return "At Risk"
    if l == "blocked":
        return "Blocked"
    if l in ("done", "complete", "completed"):
        return "Done"
    return s.strip() or "Not Started"


async def resolve_user(conn: asyncpg.Connection, owner_name: str) -> tuple[Optional[str], Optional[str]]:
    """Return (display_name, user_id_str) or (None, None) if no unique match."""
    if not owner_name.strip():
        return (None, None)
    needle = owner_name.strip().lower()
    rows = await conn.fetch(
        """
        SELECT id::text AS id, display_name, email FROM public.org_users
        WHERE COALESCE(is_active, true) = true
          AND (LOWER(COALESCE(display_name, '')) LIKE $1
               OR LOWER(COALESCE(email, '')) LIKE $1)
        """,
        f"{needle}%",
    )
    if len(rows) == 1:
        return (rows[0]["display_name"], rows[0]["id"])
    if len(rows) == 0:
        print(f"  ! No user matches '{owner_name}' — leaving owner blank.")
    else:
        names = ", ".join(r["display_name"] for r in rows)
        print(f"  ! Multiple users match '{owner_name}' ({names}) — leaving owner blank.")
    return (None, None)


def split_workstream(raw: str) -> tuple[int, str]:
    """'1. Strategy & Design' -> (1, 'Strategy & Design')."""
    m = re.match(r"^\s*(\d+)\.\s*(.+)$", raw.strip())
    if m:
        return (int(m.group(1)), m.group(2).strip())
    return (0, raw.strip())


# ── Task helpers ──────────────────────────────────────────────────────────


def normalize_task_status(s: str) -> str:
    """Map CSV statuses → DB-allowed values. The DB constraint allows
    {Not Started, In Progress, Completed, Blocked, On Hold, Done}
    after our migration."""
    l = (s or "").strip().lower()
    if l == "on track":
        return "In Progress"
    if l == "not started":
        return "Not Started"
    if l == "on hold":
        return "On Hold"
    if l in ("complete", "completed", "done"):
        return "Done"
    if l == "blocked":
        return "Blocked"
    if l == "in progress" or l == "in_progress":
        return "In Progress"
    return s.strip() or "Not Started"


def parse_mmddyyyy(s: str) -> Optional[date]:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# Tokens that look like person names but are actually placeholders,
# external teams, or qualifiers — these never resolve to a user and
# should be skipped during multi-name parsing.
NON_USER_TOKENS = {
    "tbd", "all", "team", "mckinsey", "pbd", "external support",
    "external support tbd", "external", "support",
}


def split_owner_tokens(owner_raw: str) -> list[str]:
    """'Laura / Johnny + Team' -> ['Laura', 'Johnny']. Strips '(?)',
    'External Support TBD', etc., and filters out non-user tokens."""
    if not owner_raw:
        return []
    # Split on / , +, and "&" — common separators across the sheet.
    parts = re.split(r"\s*[/,+&]\s*", owner_raw)
    out: list[str] = []
    for raw in parts:
        # Drop parenthetical qualifiers like "(?)", "(May/June)".
        cleaned = re.sub(r"\([^)]*\)", "", raw).strip()
        if not cleaned:
            continue
        if cleaned.lower() in NON_USER_TOKENS:
            continue
        out.append(cleaned)
    return out


async def resolve_owners(
    conn: asyncpg.Connection, owner_raw: str
) -> tuple[str, list[str]]:
    """For task owners that may include multiple names. Returns
    (display_string, owner_ids[]). The display string is the original
    raw value (so the UI shows what the user wrote); owner_ids is the
    list of users we could uniquely resolve."""
    tokens = split_owner_tokens(owner_raw)
    ids: list[str] = []
    for tok in tokens:
        _, uid = await resolve_user(conn, tok)
        if uid and uid not in ids:
            ids.append(uid)
    return (owner_raw.strip(), ids)


def parse_task_link(raw: str) -> tuple[list[str], str]:
    """Tasks' Link column sometimes contains a URL, sometimes a document
    title. Return (urls, non_url_label). The URLs go to task.links;
    the non-URL label gets prepended to the description so it isn't
    lost."""
    s = (raw or "").strip()
    if not s:
        return ([], "")
    if s.startswith("http://") or s.startswith("https://"):
        return ([s], "")
    return ([], s)


async def main() -> int:
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set in .env — aborting.", file=sys.stderr)
        return 2

    if not CSV_PATH.exists():
        print(f"CSV not found at {CSV_PATH}", file=sys.stderr)
        return 2

    # Parse the CSV first so we fail early if it's malformed.
    rows: list[dict[str, str]] = []
    with CSV_PATH.open(newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append({k.strip(): (v or "").strip() for k, v in r.items()})

    # Group by workstream, preserving CSV order.
    ws_order: list[str] = []
    ws_milestones: dict[str, list[dict]] = {}
    for r in rows:
        ws_raw = r.get("Workstream", "")
        if not ws_raw:
            continue
        if ws_raw not in ws_milestones:
            ws_milestones[ws_raw] = []
            ws_order.append(ws_raw)
        ws_milestones[ws_raw].append(r)

    # Parse the tasks CSV — optional. Tasks are matched to milestones
    # by (Workstream, Milestone) name.
    task_rows: list[dict[str, str]] = []
    if TASKS_CSV_PATH.exists():
        with TASKS_CSV_PATH.open(newline="") as f:
            reader = csv.DictReader(f)
            for r in reader:
                task_rows.append({k.strip(): (v or "").strip() for k, v in r.items()})
        print(f"Parsed {len(rows)} milestones, {len(task_rows)} tasks "
              f"across {len(ws_order)} workstreams from CSVs.")
    else:
        print(f"Parsed {len(rows)} milestones across {len(ws_order)} workstreams from CSV. "
              f"(No tasks CSV at {TASKS_CSV_PATH})")
    print()

    conn = await asyncpg.connect(db_url)
    try:
        project = await conn.fetchrow(
            "SELECT id::text AS id, name FROM bedrock.project "
            "WHERE deleted_at IS NULL AND (name ILIKE '%aiji%' OR name ILIKE '%ai jobs%') "
            "ORDER BY created_at DESC LIMIT 1"
        )
        if not project:
            print("No AIJI project found.", file=sys.stderr)
            return 1
        project_id = project["id"]
        print(f"Target project: {project['name']} ({project_id})")

        existing = await conn.fetch(
            "SELECT id::text AS id, name FROM bedrock.workstream "
            "WHERE project_id = $1::uuid AND deleted_at IS NULL ORDER BY sort_order",
            project_id,
        )
        print(f"Existing workstreams to remove: {len(existing)}")
        for e in existing:
            print(f"  - {e['name']}")
        print()
        print("About to:")
        print(f"  • soft-delete {len(existing)} workstream(s) and their milestones + tasks")
        print(f"  • insert {len(ws_order)} workstream(s) and {len(rows)} milestone(s)")
        if task_rows:
            print(f"  • insert {len(task_rows)} task(s)")
        ans = input("Proceed? Type 'yes' to confirm: ").strip().lower()
        if ans != "yes":
            print("Aborted.")
            return 1

        email = os.environ.get("USER", "seed-script") + "@pursuit.org"

        # Ensure the due_date column exists — additive migration, safe
        # to run repeatedly (IF NOT EXISTS).
        await conn.execute(
            "ALTER TABLE bedrock.milestone ADD COLUMN IF NOT EXISTS due_date DATE"
        )

        # Reconcile stale check constraints (user-authorized 2026-05-12).
        # status: broaden to match the new UI dropdown values.
        # priority: drop entirely — the UI doesn't surface this field.
        await conn.execute(
            "ALTER TABLE bedrock.milestone DROP CONSTRAINT IF EXISTS milestone_status_check"
        )
        await conn.execute(
            "ALTER TABLE bedrock.milestone ADD CONSTRAINT milestone_status_check "
            "CHECK (status = ANY (ARRAY["
            "'Not Started','On Track','At Risk','Needs Attention','Blocked','Done','Completed'"
            "]))"
        )
        await conn.execute(
            "ALTER TABLE bedrock.milestone DROP CONSTRAINT IF EXISTS milestone_priority_check"
        )

        # Task status: the DB constraint blocks the UI dropdown's 'Done'
        # (it currently allows 'Completed' but not 'Done'). Broaden to
        # match the frontend STATUS_OPTIONS + 'On Hold' (CSV uses it).
        await conn.execute(
            "ALTER TABLE bedrock.project_task DROP CONSTRAINT IF EXISTS project_task_status_check"
        )
        await conn.execute(
            "ALTER TABLE bedrock.project_task ADD CONSTRAINT project_task_status_check "
            "CHECK (status = ANY (ARRAY["
            "'Not Started','In Progress','Blocked','On Hold','Done','Completed'"
            "]))"
        )

        async with conn.transaction():
            # 1. Soft-delete existing workstreams + cascade
            await conn.execute(
                "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
                "WHERE milestone_id IN ("
                "  SELECT m.id FROM bedrock.milestone m "
                "  JOIN bedrock.workstream w ON w.id = m.workstream_id "
                "  WHERE w.project_id = $1::uuid AND w.deleted_at IS NULL"
                ") AND deleted_at IS NULL",
                project_id, email,
            )
            await conn.execute(
                "UPDATE bedrock.milestone SET deleted_at = now(), deleted_by = $2 "
                "WHERE workstream_id IN ("
                "  SELECT id FROM bedrock.workstream "
                "  WHERE project_id = $1::uuid AND deleted_at IS NULL"
                ") AND deleted_at IS NULL",
                project_id, email,
            )
            await conn.execute(
                "UPDATE bedrock.workstream SET deleted_at = now(), deleted_by = $2 "
                "WHERE project_id = $1::uuid AND deleted_at IS NULL",
                project_id, email,
            )

            # 2. Insert workstreams + milestones. Index milestones by
            #    (workstream_raw, milestone_title) so tasks can resolve.
            ms_index: dict[tuple[str, str], str] = {}
            for ws_idx, ws_raw in enumerate(ws_order, start=0):
                _, ws_name = split_workstream(ws_raw)
                ws_row = await conn.fetchrow(
                    "INSERT INTO bedrock.workstream (project_id, name, description, sort_order) "
                    "VALUES ($1::uuid, $2, '', $3) RETURNING id::text AS id",
                    project_id, ws_name, ws_idx,
                )
                wsid = ws_row["id"]
                print(f"+ Workstream: {ws_name}")

                for ms_idx, r in enumerate(ws_milestones[ws_raw], start=0):
                    title = r["Milestones"]
                    status = normalize_status(r.get("Status", ""))
                    due_date = parse_timeline(r.get("Timeline", ""))
                    description = r.get("Description", "")
                    source_links = parse_source_links(r.get("Source", ""))
                    owner_name = r.get("Owner", "")
                    owner_display, owner_id = await resolve_user(conn, owner_name)

                    owner_ids = [owner_id] if owner_id else []
                    msid_row = await conn.fetchrow(
                        """INSERT INTO bedrock.milestone
                           (workstream_id, title, status, priority, owner, owner_ids,
                            due_date, description, source_links, sort_order)
                           VALUES ($1::uuid, $2, $3, '', $4, $5::uuid[], $6, $7, $8, $9)
                           RETURNING id::text AS id""",
                        wsid, title, status,
                        owner_display or "",
                        owner_ids,
                        due_date,
                        description,
                        source_links,
                        ms_idx,
                    )
                    ms_index[(ws_raw, title)] = msid_row["id"]
                    extras = []
                    if due_date:
                        extras.append(f"due {due_date.isoformat()}")
                    if owner_display:
                        extras.append(f"owner {owner_display}")
                    if source_links:
                        extras.append(f"{len(source_links)} link(s)")
                    extra_str = f" [{', '.join(extras)}]" if extras else ""
                    print(f"    · {title} ({status}){extra_str}")

            # 3. Insert tasks. Match on (Workstream, Milestone) names.
            if task_rows:
                print()
                print(f"Inserting {len(task_rows)} task(s)…")
                unmatched: list[str] = []
                # per-milestone counter to set sort_order monotonically
                ms_task_count: dict[str, int] = {}
                inserted = 0
                for t in task_rows:
                    ws_raw_t = t.get("Workstream", "").strip()
                    ms_title_t = t.get("Milestone", "").strip()
                    msid = ms_index.get((ws_raw_t, ms_title_t))
                    if not msid:
                        unmatched.append(f"{ws_raw_t} / {ms_title_t} :: {t.get('Task', '')}")
                        continue

                    title = t.get("Task", "").strip()
                    if not title:
                        continue

                    status = normalize_task_status(t.get("Status", ""))
                    deadline = parse_mmddyyyy(t.get("Deadline", ""))
                    description = t.get("Description", "")
                    updates = t.get("Progress updates", "")
                    link_urls, link_label = parse_task_link(t.get("Link", ""))
                    if link_label:
                        # Preserve non-URL Link cell content (e.g. document
                        # titles) in the description so it isn't lost.
                        prefix = f"[Ref: {link_label}]"
                        description = f"{prefix}\n\n{description}" if description else prefix
                    owner_raw = t.get("Owner", "")
                    owner_display, owner_ids = await resolve_owners(conn, owner_raw)

                    sort = ms_task_count.get(msid, 0)
                    ms_task_count[msid] = sort + 1

                    await conn.execute(
                        """INSERT INTO bedrock.project_task
                           (milestone_id, title, status, owner, owner_ids,
                            deadline, start_date, description, updates, links,
                            depends_on, sort_order)
                           VALUES ($1::uuid, $2, $3, $4, $5::uuid[], $6, NULL,
                                   $7, $8, $9, '{}'::uuid[], $10)""",
                        msid, title, status, owner_display, owner_ids,
                        deadline, description, updates, link_urls, sort,
                    )
                    inserted += 1

                print(f"  inserted {inserted} task(s)")
                if unmatched:
                    print(f"  ! {len(unmatched)} task(s) did not match a milestone — skipped:")
                    for u in unmatched:
                        print(f"     · {u}")

        print()
        print("Done.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
