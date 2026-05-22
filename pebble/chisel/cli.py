"""``chisel`` CLI — author/inspect/validate tools and workflows.

Phase A surface (argparse, plan §11.4):

  * ``chisel list`` — print loaded tools + workflows.
  * ``chisel validate [path]`` — schema + lint check one unit or the tree.
  * ``chisel scaffold <name>`` — write a fresh tool dir with manifest +
    handler stub + handler_test.py scaffold (plan §P10).

Phase B will add ``chisel eval``. Phase C wires the same operations
behind ``/api/chisel/*``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .autoload import autoload
from .lints import lint_handler_module


HANDLER_STUB = '''"""Handler for `{name}`. See manifest.yaml for the declarative half."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from pebble.chisel.handler_adapter import HandlerContext


class Input(BaseModel):
    # TODO: replace with real fields
    query: str = Field(min_length=1)


async def run(args: Input, ctx: HandlerContext) -> dict[str, Any]:
    # TODO: implement
    raise NotImplementedError("scaffold: implement {name}.run")
'''

MANIFEST_STUB = """\
name: {name}
description: TODO short description
version: 1.0.0
tags: []
requires_human: false
cost_estimate:
  fixed: 0.0
output_kind: prose
scope: global
"""

TEST_STUB = '''"""Tests for `{name}`."""

from __future__ import annotations

import pytest

from pebble.chisel.handler_adapter import HandlerContext
from pebble.orchestrator.tools import ToolContext

from pebble.chisel.tools.{name}.handler import Input, run


@pytest.mark.asyncio
async def test_{name}_smoke() -> None:
    ctx = HandlerContext(ToolContext(user_email="t@pursuit.org", conversation_id="c1"))
    with pytest.raises(NotImplementedError):
        await run(Input(query="hi"), ctx)
'''


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="chisel")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list discovered tools + workflows")

    v = sub.add_parser("validate", help="validate manifests + lint handlers")
    v.add_argument("path", nargs="?", help="tool dir to validate (default: all)")

    s = sub.add_parser("scaffold", help="create a new tool dir")
    s.add_argument("name", help="tool name, snake_case")

    args = parser.parse_args(argv)

    if args.cmd == "list":
        return _cmd_list()
    if args.cmd == "validate":
        return _cmd_validate(args.path)
    if args.cmd == "scaffold":
        return _cmd_scaffold(args.name)
    parser.error(f"unknown command {args.cmd!r}")
    return 2


def _cmd_list() -> int:
    report = autoload()
    print(f"tools     ({len(report.loaded_tools)}):", *report.loaded_tools, sep="\n  ")
    print(f"workflows ({len(report.loaded_workflows)}):", *report.loaded_workflows, sep="\n  ")
    if report.errors:
        print("\nerrors:")
        for path, reason in report.errors:
            print(f"  {path}: {reason}")
        return 1
    return 0


def _cmd_validate(path: str | None) -> int:
    report = autoload()
    failed = False

    if path:
        handler_path = Path(path) / "handler.py"
        if handler_path.is_file():
            errs = lint_handler_module(handler_path)
            for err in errs:
                print(f"lint:{err.rule}:{err.lineno}: {err.message}")
                failed = True

    for unit_path, reason in report.errors:
        print(f"autoload: {unit_path}: {reason}")
        failed = True

    return 1 if failed else 0


def _cmd_scaffold(name: str) -> int:
    if not name.isidentifier() or not name.islower():
        print(f"scaffold: name must be snake_case identifier, got {name!r}", file=sys.stderr)
        return 2

    base = Path(__file__).parent / "tools" / name
    if base.exists():
        print(f"scaffold: {base} already exists", file=sys.stderr)
        return 2
    base.mkdir(parents=True)
    (base / "__init__.py").write_text("", encoding="utf-8")
    (base / "manifest.yaml").write_text(MANIFEST_STUB.format(name=name), encoding="utf-8")
    (base / "handler.py").write_text(HANDLER_STUB.format(name=name), encoding="utf-8")
    (base / "handler_test.py").write_text(TEST_STUB.format(name=name), encoding="utf-8")
    print(f"scaffold: created {base}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
