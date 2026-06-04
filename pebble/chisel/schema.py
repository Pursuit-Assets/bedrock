"""Pydantic → strict JSON Schema.

Pydantic's default ``model_json_schema()`` emits permissive object
schemas (no ``additionalProperties: false``). The Pebble planner needs
strict schemas so it cannot smuggle unknown args past tool handlers
(plan §P1). This module inlines ``$ref`` / ``$defs`` and forces
``additionalProperties: false`` on every object node.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from pydantic import BaseModel


def pydantic_to_strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Emit a JSON Schema in the shape the Anthropic tool-use API
    consumes, with ``additionalProperties: false`` enforced everywhere."""
    raw = model.model_json_schema(ref_template="#/$defs/{model}")
    inlined = _inline_refs(raw)
    _enforce_strict_objects(inlined)
    return inlined


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


def _enforce_strict_objects(schema: dict[str, Any]) -> None:
    """Mutate ``schema`` in place so every ``type: object`` node has
    ``additionalProperties: false``."""

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                node["additionalProperties"] = False
            for v in node.values():
                visit(v)
        elif isinstance(node, list):
            for v in node:
                visit(v)

    visit(schema)
