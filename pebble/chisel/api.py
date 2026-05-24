"""``/api/chisel/*`` HTTP surface for the Phase-C GUI.

Read-only for v1:
  * GET  /api/chisel/health                — autoload status
  * GET  /api/chisel/tools                 — list every tool
  * GET  /api/chisel/tools/{name}          — manifest + handler source + schema
  * GET  /api/chisel/workflows             — list every workflow
  * GET  /api/chisel/workflows/{name}      — manifest + build_plan source
  * POST /api/chisel/validate              — validate a manifest YAML string
  * POST /api/chisel/reload                — re-run autoload, return health
  * POST /api/chisel/eval                  — run canonical_queries through planner

Auth: ``verify_api_key`` + ``require_pebble_permission("use_pebble_chat")``
(chat permission gates GUI reads; a dedicated ``chisel_write`` permission
will gate the write endpoints when Phase C.2 lands).
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import service as _svc


# Body models live at module scope so FastAPI's introspection can
# resolve their annotations at decoration time (defining them inside
# build_router clashes with `from __future__ import annotations`).

class ValidateBody(BaseModel):
    kind: str  # "tool" | "workflow"
    manifest_yaml: str


class EvalBody(BaseModel):
    unit: Optional[str] = None
    tag: Optional[str] = None


def build_router(*, auth_dependencies: Optional[list] = None) -> APIRouter:
    """Construct the chisel API router. ``auth_dependencies`` is a list
    of FastAPI dependencies applied to every endpoint — production
    wires in ``[Depends(verify_api_key), Depends(require_pebble_permission(...))]``;
    tests pass ``[]``."""
    deps = auth_dependencies or []
    router = APIRouter(prefix="/api/chisel", tags=["chisel"], dependencies=deps)

    @router.get("/health")
    def _health() -> dict:
        return _svc.current_health().to_dict()

    @router.get("/tools")
    def _list_tools() -> dict:
        units = [u.to_dict() for u in _svc.list_units() if u.kind == "tool"]
        return {"tools": units}

    @router.get("/tools/{name}")
    def _get_tool(name: str) -> dict:
        detail = _svc.get_tool_detail(name)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"tool not found: {name}")
        return detail.to_dict()

    @router.get("/workflows")
    def _list_workflows() -> dict:
        units = [u.to_dict() for u in _svc.list_units() if u.kind == "workflow"]
        return {"workflows": units}

    @router.get("/workflows/{name}")
    def _get_workflow(name: str) -> dict:
        detail = _svc.get_workflow_detail(name)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"workflow not found: {name}")
        return detail.to_dict()

    @router.post("/validate")
    def _validate(body: ValidateBody) -> dict:
        if body.kind == "tool":
            issues = _svc.validate_tool_manifest_yaml(body.manifest_yaml)
        elif body.kind == "workflow":
            issues = _svc.validate_workflow_manifest_yaml(body.manifest_yaml)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"kind must be 'tool' or 'workflow', got {body.kind!r}",
            )
        return {
            "ok": not issues,
            "issues": [i.to_dict() for i in issues],
        }

    @router.post("/reload")
    def _reload() -> dict:
        return _svc.reload_chisel().to_dict()

    @router.post("/eval")
    async def _eval(body: EvalBody) -> dict:
        import os
        from pebble.orchestrator.planner import Planner
        from pebble.orchestrator.tools import DEFAULT_REGISTRY, ToolContext

        planner = None
        ctx = None
        if os.environ.get("ANTHROPIC_API_KEY"):
            from pebble.llm.anthropic_client import get_default_client
            planner = Planner(client=get_default_client(), registry=DEFAULT_REGISTRY)
            ctx = ToolContext(user_email="chisel-eval@pursuit.org", conversation_id="chisel-api")

        summary = await _svc.run_canonical_eval(
            unit=body.unit, tag=body.tag, planner=planner, ctx=ctx,
        )
        return summary.to_dict()

    return router
