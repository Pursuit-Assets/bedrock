"""Process-local registry snapshots.

Plan §5 (P5): naive ``unregister + register`` during a reload races
against in-flight tool calls. Mitigation chosen: snapshot-per-request.
The executor takes one ``snapshot(DEFAULT_REGISTRY)`` at request entry
and threads that immutable view through plan + execute + render. A
concurrent ``autoload(reload=True)`` mutating ``DEFAULT_REGISTRY``
doesn't change what the in-flight request sees.

Snapshots are cheap — ``dict(self._specs)`` over <30 entries.
"""

from __future__ import annotations

from pebble.orchestrator.tools import ToolRegistry


def snapshot(source: ToolRegistry) -> ToolRegistry:
    """Return a new ``ToolRegistry`` populated with the current specs of
    ``source``. Mutations to ``source`` after this call do not affect the
    returned snapshot."""
    snap = ToolRegistry()
    # ToolSpec is frozen — sharing the spec instance is safe.
    for spec in source.iter_specs():
        snap.register(spec)
    return snap
