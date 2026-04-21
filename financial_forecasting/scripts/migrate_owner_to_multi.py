"""Migrate bedrock.{milestone,project_task}.owner free-text into owner_ids (UUID[]).

Parses each row's `owner` column, resolves tokens against `public.org_users`,
populates `owner_ids`, and reduces `owner` to only the unmatched tokens
("Other" labels like McKinsey, Hudson Ferris, PBD, TBD, + Team).

Idempotent: re-running on already-migrated rows makes no change. Matches the
parser used by scripts/import_aiji_tracker.py so re-imports stay consistent.

Usage (from financial_forecasting/):
    python -m scripts.migrate_owner_to_multi \\
        [--project-id <uuid>] [--dry-run] [--yes]

Requires DATABASE_URL (same discipline as db.py).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import List, Tuple
from urllib.parse import urlparse

import asyncpg
from dotenv import load_dotenv

# Allow `python -m scripts.migrate_owner_to_multi` from financial_forecasting/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts._owner_parser import build_user_map, parse_owner_string  # noqa: E402

load_dotenv(override=False)
logger = logging.getLogger("migrate_owner_to_multi")

Change = Tuple[uuid.UUID, str, str, str, List[uuid.UUID]]
#      = (row_id, title, old_owner, new_owner_other, owner_ids)


async def _gather_changes(
    conn: asyncpg.Connection,
    project_uuid: uuid.UUID | None,
) -> Tuple[List[Change], List[Change], dict]:
    """Return (milestone_changes, task_changes, user_map_summary)."""
    user_rows = await conn.fetch(
        "SELECT id, display_name FROM public.org_users "
        "WHERE COALESCE(is_active, true) = true AND display_name IS NOT NULL"
    )
    user_map = build_user_map([dict(r) for r in user_rows])

    extra = "AND w.project_id = $1" if project_uuid else ""
    params = [project_uuid] if project_uuid else []

    ms_rows = await conn.fetch(
        f"""
        SELECT m.id, m.title, m.owner, m.owner_ids
        FROM bedrock.milestone m
        JOIN bedrock.workstream w ON w.id = m.workstream_id
        WHERE m.deleted_at IS NULL AND m.owner <> '' {extra}
        ORDER BY m.created_at
        """,
        *params,
    )
    t_rows = await conn.fetch(
        f"""
        SELECT t.id, t.title, t.owner, t.owner_ids
        FROM bedrock.project_task t
        JOIN bedrock.milestone m ON m.id = t.milestone_id
        JOIN bedrock.workstream w ON w.id = m.workstream_id
        WHERE t.deleted_at IS NULL AND t.owner <> '' {extra}
        ORDER BY t.created_at
        """,
        *params,
    )

    ms_changes: List[Change] = []
    for r in ms_rows:
        ids, other = parse_owner_string(r["owner"], user_map)
        existing_ids = list(r["owner_ids"] or [])
        if existing_ids != ids or r["owner"] != other:
            ms_changes.append((r["id"], r["title"], r["owner"], other, ids))

    t_changes: List[Change] = []
    for r in t_rows:
        ids, other = parse_owner_string(r["owner"], user_map)
        existing_ids = list(r["owner_ids"] or [])
        if existing_ids != ids or r["owner"] != other:
            t_changes.append((r["id"], r["title"], r["owner"], other, ids))

    return ms_changes, t_changes, {"user_map_keys": len(user_map), "active_users": len(user_rows)}


def _print_changes(label: str, changes: List[Change]) -> None:
    print(f"\n=== {label} ({len(changes)}) ===")
    for _rid, title, old_owner, new_owner, ids in changes:
        shown = title[:50]
        print(f"  {shown}")
        print(f"    owner:      {old_owner!r} → {new_owner!r}")
        print(f"    owner_ids:  {[str(u) for u in ids]}")


async def _amain(args: argparse.Namespace) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if not dsn:
        print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
        return 3
    parsed = urlparse(dsn)
    masked = (
        f"{parsed.scheme}://{parsed.username}:****@"
        f"{parsed.hostname}:{parsed.port}{parsed.path}"
    )
    print(f"Target DB: {masked}")

    project_uuid = uuid.UUID(args.project_id) if args.project_id else None

    conn = await asyncpg.connect(dsn)
    try:
        ms_changes, t_changes, summary = await _gather_changes(conn, project_uuid)
        print(
            f"Active users: {summary['active_users']}  "
            f"user-map tokens: {summary['user_map_keys']}"
        )
        _print_changes("Milestone changes", ms_changes)
        _print_changes("Task changes", t_changes)

        if not ms_changes and not t_changes:
            print("\nNothing to migrate. All rows already consistent with owner_ids.")
            return 0

        if args.dry_run:
            print("\nDry run only. No DB writes performed.")
            return 0

        if not args.yes:
            try:
                ans = input(
                    f"\nApply {len(ms_changes)} milestone + {len(t_changes)} task updates "
                    f"on {masked}? [y/N]: "
                )
            except EOFError:
                ans = ""
            if ans.strip().lower() not in ("y", "yes"):
                print("Aborted.")
                return 0

        async with conn.transaction():
            for rid, _title, _old, new_other, ids in ms_changes:
                await conn.execute(
                    "UPDATE bedrock.milestone "
                    "SET owner_ids = $1, owner = $2 "
                    "WHERE id = $3 AND deleted_at IS NULL",
                    ids, new_other, rid,
                )
            for rid, _title, _old, new_other, ids in t_changes:
                await conn.execute(
                    "UPDATE bedrock.project_task "
                    "SET owner_ids = $1, owner = $2 "
                    "WHERE id = $3 AND deleted_at IS NULL",
                    ids, new_other, rid,
                )
        print(
            f"\nMigration applied: "
            f"{len(ms_changes)} milestones + {len(t_changes)} tasks updated."
        )
        return 0
    finally:
        await conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Migrate bedrock.{milestone,project_task}.owner free-text to owner_ids + Other TEXT."
    )
    parser.add_argument("--project-id", default=None, help="Restrict to one project UUID")
    parser.add_argument("--dry-run", action="store_true", help="Parse + summarize, no DB writes")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip the confirmation prompt")
    args = parser.parse_args(argv)
    return asyncio.run(_amain(args))


if __name__ == "__main__":
    sys.exit(main())
