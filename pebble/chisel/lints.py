"""Static lints over a Chisel handler module.

Per plan §3 / §7 lint surface:

  * ``import httpx`` (or ``from httpx import ...``) at module top — handlers
    must use ``ctx.http_client`` so audit + timeout policy is centralized.
  * ``os.environ`` reads inside ``run()`` — config must flow through ctx.
  * ``async def run`` is required — sync ``run`` breaks the adapter.

Run via ``chisel validate`` or at autoload time (errors → AutoloadReport).
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LintError:
    rule: str
    message: str
    lineno: int = 0


def lint_handler_module(
    path: Path | str,
    *,
    overrides: tuple[str, ...] = (),
) -> list[LintError]:
    p = Path(path)
    source = p.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(p))
    errors: list[LintError] = []

    overrides_set = set(overrides)

    def emit(rule: str, message: str, lineno: int) -> None:
        if rule in overrides_set:
            return
        errors.append(LintError(rule=rule, message=message, lineno=lineno))

    _check_no_bare_httpx(tree, emit)
    _check_run_signature(tree, emit)
    _check_no_env_in_run(tree, emit)
    return errors


def _check_no_bare_httpx(tree: ast.AST, emit) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "httpx" or alias.name.startswith("httpx."):
                    emit(
                        "no_bare_httpx",
                        "handler imports httpx directly; use ctx.http_client",
                        node.lineno,
                    )
        elif isinstance(node, ast.ImportFrom):
            if node.module == "httpx" or (
                node.module and node.module.startswith("httpx.")
            ):
                emit(
                    "no_bare_httpx",
                    "handler imports from httpx directly; use ctx.http_client",
                    node.lineno,
                )


def _check_run_signature(tree: ast.AST, emit) -> None:
    found = False
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run":
            found = True
            if isinstance(node, ast.FunctionDef):
                emit(
                    "async_run_required",
                    "`run` must be defined with `async def`",
                    node.lineno,
                )
    if not found:
        emit("async_run_required", "module is missing `async def run`", 0)


def _check_no_env_in_run(tree: ast.AST, emit) -> None:
    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.AsyncFunctionDef) or node.name != "run":
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Attribute):
                if (
                    isinstance(sub.value, ast.Name)
                    and sub.value.id == "os"
                    and sub.attr == "environ"
                ):
                    emit(
                        "no_env_in_run",
                        "run() reads os.environ; flow config through ctx",
                        sub.lineno,
                    )
