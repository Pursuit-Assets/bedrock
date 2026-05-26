"""Chisel — Pebble's tool/workflow authoring framework.

A tool or workflow is a directory under ``pebble/chisel/{tools,workflows}/``
containing a declarative ``manifest.yaml`` plus a Python ``handler.py``.
``autoload()`` walks those dirs and registers each unit on the shared
``DEFAULT_REGISTRY`` so the planner / executor / renderer pick them up
through the existing contract.

Autoload runs at module import so any pebble-package consumer (the
streaming handler, the router, the CLI) sees a populated registry
without explicit wiring. Tests pass ``registry=fresh_registry`` to
``autoload()`` for isolation; the maps used by the router
(``lookup_slash`` / ``lookup_intent``) reset on every call.
"""

from __future__ import annotations

from .autoload import (
    AutoloadReport,
    WorkflowEntry,
    autoload,
    lookup_intent,
    lookup_slash,
)
from .reload import snapshot

__all__ = [
    "AutoloadReport",
    "WorkflowEntry",
    "autoload",
    "lookup_intent",
    "lookup_slash",
    "snapshot",
]


# Run autoload at import time so any pebble path that imports chisel
# sees a populated DEFAULT_REGISTRY. Errors flow through the report and
# get logged; the process boots with whatever loaded successfully.
_BOOT_REPORT = autoload()
