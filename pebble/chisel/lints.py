"""Static lints over a Chisel handler module. Advisory at autoload
(emitted as warnings); ``chisel validate`` exits non-zero on lint hits.

Checks:
  * ``import httpx`` (or ``from httpx import ...``) — handlers must use
    ``ctx.http_client`` so audit + timeout policy stay centralized.
  * ``async def run`` is required — sync ``run`` breaks the adapter.

Dropped ``no_env_in_run`` (Phase B cleanup): trivially evadable via
``from os import environ``; load-bearing only if enforced robustly.
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


def lint_handler_module(path: Path | str) -> list[LintError]:
    p = Path(path)
    source = p.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(p))
    errors: list[LintError] = []
    _check_no_bare_httpx(tree, errors)
    _check_async_run(tree, errors)
    return errors


def _check_no_bare_httpx(tree: ast.AST, errors: list[LintError]) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "httpx" or alias.name.startswith("httpx."):
                    errors.append(LintError(
                        rule="no_bare_httpx",
                        message="handler imports httpx directly; use ctx.http_client",
                        lineno=node.lineno,
                    ))
        elif isinstance(node, ast.ImportFrom):
            if node.module == "httpx" or (
                node.module and node.module.startswith("httpx.")
            ):
                errors.append(LintError(
                    rule="no_bare_httpx",
                    message="handler imports from httpx directly; use ctx.http_client",
                    lineno=node.lineno,
                ))


def _check_async_run(tree: ast.AST, errors: list[LintError]) -> None:
    found = False
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run":
            found = True
            if isinstance(node, ast.FunctionDef):
                errors.append(LintError(
                    rule="async_run_required",
                    message="`run` must be defined with `async def`",
                    lineno=node.lineno,
                ))
    if not found:
        errors.append(LintError(
            rule="async_run_required",
            message="module is missing `async def run`",
        ))
