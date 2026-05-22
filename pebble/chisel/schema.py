"""Pydantic → strict JSON Schema.

Pydantic's default ``model_json_schema()`` emits permissive object schemas
(no ``additionalProperties: false``). The Pebble planner historically uses
``make_input_schema(additional_properties=False)`` so the planner cannot
smuggle unknown args past tool handlers — see ``tasks/pebble-chisel-plan.md
§P1`` for the failure mode.

This module post-processes the Pydantic-emitted schema:

  1. Inlines ``$ref`` / ``$defs`` so the result is self-contained.
  2. Injects ``additionalProperties: false`` at every ``type: object`` node.

Tests assert the invariant on every registered tool's schema.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from pydantic import BaseModel


def pydantic_to_strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Emit a JSON Schema in the shape the Anthropic tool-use API consumes,
    with ``additionalProperties: false`` enforced at every object node."""
    raw = model.model_json_schema(ref_template="#/$defs/{model}")
    inlined = _inline_refs(raw)
    return _enforce_strict_objects(inlined)


def assert_strict(schema: dict[str, Any]) -> None:
    """Invariant check: every ``type: object`` node has
    ``additionalProperties: false``. Used in tests."""
    for node in _walk_object_nodes(schema):
        ap = node.get("additionalProperties")
        if ap is not False:
            raise AssertionError(
                f"object node missing additionalProperties:false (got {ap!r}): "
                f"keys={sorted(node.keys())}",
            )


# ---------------------------------------------------------------------------
# internal
# ---------------------------------------------------------------------------

def _inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    defs = schema.get("$defs", {})
    out = deepcopy(schema)
    out.pop("$defs", None)

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node and len(node) == 1:
                ref = node["$ref"]
                if not ref.startswith("#/$defs/"):
                    return node
                target = defs.get(ref.removeprefix("#/$defs/"))
                if target is None:
                    return node
                return resolve(deepcopy(target))
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(out)


def _enforce_strict_objects(schema: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(schema)
    for node in _walk_object_nodes(out):
        node.setdefault("additionalProperties", False)
        if node["additionalProperties"] is not False:
            node["additionalProperties"] = False
    return out


def _walk_object_nodes(schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Yield every dict node where ``type == 'object'``. Walks into
    properties, items, anyOf/oneOf/allOf branches, and $defs."""
    found: list[dict[str, Any]] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                found.append(node)
            for v in node.values():
                visit(v)
        elif isinstance(node, list):
            for v in node:
                visit(v)

    visit(schema)
    return found
