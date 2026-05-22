"""Chisel — Pebble's tool/workflow authoring framework.

A tool or workflow becomes a directory under ``pebble/chisel/{tools,workflows}/``
containing a declarative ``manifest.yaml`` plus a Python ``handler.py``. At
process start, ``autoload()`` walks those dirs and registers each one on the
shared ``DEFAULT_REGISTRY`` so the planner / executor / renderer pick them up
through the existing contract.

Public surface (kept small on purpose):

    autoload(registry=None, root=None) -> AutoloadReport
    snapshot(registry) -> ToolRegistry
    slash_command_map() -> dict[str, str]
    dispatch_workflow(intent) -> str | None

See ``tasks/pebble-chisel-plan.md`` for the locked phase-A spec.
"""

from __future__ import annotations

from .autoload import AutoloadReport, autoload, dispatch_workflow, slash_command_map
from .reload import snapshot

__all__ = [
    "AutoloadReport",
    "autoload",
    "dispatch_workflow",
    "slash_command_map",
    "snapshot",
]
