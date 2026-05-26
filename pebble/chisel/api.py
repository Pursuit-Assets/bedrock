"""``/api/chisel/*`` HTTP surface for the Phase-C GUI.

Read surface (C.1):
  * GET  /api/chisel/health
  * GET  /api/chisel/tools
  * GET  /api/chisel/tools/{name}
  * GET  /api/chisel/workflows
  * GET  /api/chisel/workflows/{name}
  * POST /api/chisel/validate
  * POST /api/chisel/reload
  * POST /api/chisel/eval

Write surface (C.3):
  * PUT  /api/chisel/tools/{name}/manifest
  * PUT  /api/chisel/workflows/{name}/manifest
  * POST /api/chisel/workflows                 — create new declarative workflow

Auth: reads gated by ``use_pebble_chat``; writes gated by a stricter
permission (``use_pebble_research`` as a stand-in until Sprint-12
ships a dedicated ``use_pebble_chisel_write``).
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import service as _svc


class ValidateBody(BaseModel):
    kind: str  # "tool" | "workflow"
    manifest_yaml: str


class EvalBody(BaseModel):
    unit: Optional[str] = None
    tag: Optional[str] = None


class SaveManifestBody(BaseModel):
    manifest_yaml: str


class CreateWorkflowBody(BaseModel):
    name: str
    manifest_yaml: str


def build_router(
    *,
    read_dependencies: Optional[list] = None,
    write_dependencies: Optional[list] = None,
    auth_dependencies: Optional[list] = None,
) -> APIRouter:
    """Build the chisel router. ``read_dependencies`` gate the GET/POST
    inspect endpoints; ``write_dependencies`` gate manifest saves. If
    ``write_dependencies`` is None, defaults to the read set (useful for
    in-process tests + dev mode). ``auth_dependencies`` is a backward-
    compat alias from C.1 that applies the same list to both."""
    if auth_dependencies is not None:
        read_dependencies = auth_dependencies
        write_dependencies = auth_dependencies
    read_deps = read_dependencies or []
    write_deps = write_dependencies if write_dependencies is not None else read_deps
    router = APIRouter(prefix="/api/chisel", tags=["chisel"])

    # ------------------------------------------------------------------
    # Read endpoints
    # ------------------------------------------------------------------

    @router.get("/health", dependencies=read_deps)
    def _health() -> dict:
        return _svc.current_health().to_dict()

    @router.get("/tools", dependencies=read_deps)
    def _list_tools() -> dict:
        return {"tools": [u.to_dict() for u in _svc.list_units() if u.kind == "tool"]}

    @router.get("/tools/{name}", dependencies=read_deps)
    def _get_tool(name: str) -> dict:
        detail = _svc.get_tool_detail(name)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"tool not found: {name}")
        return detail.to_dict()

    @router.get("/workflows", dependencies=read_deps)
    def _list_workflows() -> dict:
        return {"workflows": [u.to_dict() for u in _svc.list_units() if u.kind == "workflow"]}

    @router.get("/workflows/{name}", dependencies=read_deps)
    def _get_workflow(name: str) -> dict:
        detail = _svc.get_workflow_detail(name)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"workflow not found: {name}")
        return detail.to_dict()

    @router.post("/validate", dependencies=read_deps)
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
        return {"ok": not issues, "issues": [i.to_dict() for i in issues]}

    @router.post("/reload", dependencies=read_deps)
    def _reload() -> dict:
        return _svc.reload_chisel().to_dict()

    @router.post("/eval", dependencies=read_deps)
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

    # ------------------------------------------------------------------
    # Write endpoints (Phase C.3)
    # ------------------------------------------------------------------

    @router.put("/tools/{name}/manifest", dependencies=write_deps)
    def _save_tool_manifest(name: str, body: SaveManifestBody) -> dict:
        try:
            unit = _svc.save_tool_manifest(name, body.manifest_yaml)
        except _svc.ChiselSaveError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e))
        return {"ok": True, "unit": unit.to_dict()}

    @router.put("/workflows/{name}/manifest", dependencies=write_deps)
    def _save_workflow_manifest(name: str, body: SaveManifestBody) -> dict:
        try:
            unit = _svc.save_workflow_manifest(name, body.manifest_yaml)
        except _svc.ChiselSaveError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e))
        return {"ok": True, "unit": unit.to_dict()}

    @router.post("/workflows", dependencies=write_deps)
    def _create_workflow(body: CreateWorkflowBody) -> dict:
        try:
            unit = _svc.create_workflow(body.name, body.manifest_yaml)
        except _svc.ChiselSaveError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e))
        return {"ok": True, "unit": unit.to_dict()}

    return router
