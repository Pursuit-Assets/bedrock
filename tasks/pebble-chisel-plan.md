# Chisel — Implementation Plan

> **Status:** Plan drafted 2026-05-12. Awaiting user review before implementation begins.
> **Branch:** `feat/pebble-chisel-scoping` (worktree off `feat/pebble-phase-0`).
> **Scope source of truth:** `tasks/pebble-chisel-scoping.md` (this doc resolves the open P1–P14 follow-ups from §7.5 there).
> **Three PRs, in order:** Phase A (Framework) → Phase B (Eval harness) → Phase C (GUI builder). No coexistence with the legacy registration pattern after Phase A merges.

---

## §0 — What this plan covers

The scoping doc locks the *what* (D1–D8). This plan locks the *how*: package layout, file-by-file changes, manifest schema, runtime behaviour, RBAC integration, migration strategy, test surface, and per-phase risk register. Every P1–P14 follow-up from `pebble-chisel-scoping.md §7.5` is resolved below with explicit references.

Anything left as an open question after this plan is called out in **§11 — Decisions deferred to implementation** so you can redirect before I start coding.

---

## §1 — Architecture in one paragraph

Each tool or workflow becomes a directory at `pebble/chisel/{tools,workflows}/<name>/` containing a `manifest.yaml` (declarative shape: name, description, tags, cost, RBAC, eval fixtures) and a `handler.py` (Pydantic input model class + async `run` function) plus optional `render.py`, `render.md.j2`, `build_plan.py`, and `canonical_queries.yaml`. At process start, `chisel.autoload(DEFAULT_REGISTRY)` walks the dirs, validates each manifest against a Pydantic schema, derives a strict JSON Schema from each handler's Pydantic input model (with `additionalProperties: false` injected), wraps the user's `run` function in a `ToolResult`-constructing adapter, and registers the resulting `ToolSpec` on the registry. The same call also populates `_SLASH_COMMANDS` and the workflow-dispatch map. Phase B adds `chisel eval` running canonical queries through the live planner and diffing against expectations. Phase C adds `/api/chisel/*` FastAPI endpoints and a React UI under `financial_forecasting/frontend-v2/src/pages/chisel/` so non-engineers can compose manifests visually with the same validation guardrails.

ASCII diagram:

```
                                  ┌──────────────────────────────┐
                                  │ pebble/chisel/tools/<name>/  │
                                  │  ├── manifest.yaml           │
                                  │  ├── handler.py (Pydantic +  │
                                  │  │    async run)             │
                                  │  ├── render.py | render.md.j2│
                                  │  │   (optional)              │
                                  │  └── canonical_queries.yaml  │
                                  │      (Phase B)               │
                                  └──────────────┬───────────────┘
                                                 │
                                ┌────────────────┴────────────────┐
                                │ chisel.autoload(registry)        │
                                │   1. discover dirs               │
                                │   2. validate manifest schema    │
                                │   3. import handler.py           │
                                │   4. pydantic→json-schema (strict)│
                                │   5. wrap run() → ToolResult     │
                                │   6. registry.register(spec)     │
                                │   7. populate slash-cmd & intent │
                                └────────────────┬────────────────┘
                                                 │
   ┌─────────────────────────────────────────────┴─────────────────────────────┐
   │                                                                            │
   │   pebble.orchestrator.tools.DEFAULT_REGISTRY (unchanged contract)          │
   │                                                                            │
   └─────────────────────────────────────────────┬─────────────────────────────┘
                                                 │
                                  used by: planner, executor, renderer, evaluator
                                  authored by: engineers (CLI) + non-engineers (GUI)
```

---

## §2 — Final package layout

After Phase A merges, the new and changed files are:

```
pebble/
├── chisel/                                # NEW — Chisel framework + manifests
│   ├── __init__.py                        # public surface: autoload, scaffold, reload
│   ├── autoload.py                        # the discovery + register pipeline
│   ├── manifest.py                        # Pydantic models for manifest.yaml / workflow.yaml
│   ├── handler_adapter.py                 # wraps user run() → ToolResult; constructs dict→Pydantic
│   ├── schema.py                          # Pydantic → strict JSON Schema (P1)
│   ├── rbac.py                            # permission enforcement at dispatch
│   ├── lints.py                           # static checks (no bare httpx, etc.)
│   ├── cli.py                             # `chisel <subcommand>` entry point
│   ├── reload.py                          # process-local reload mechanic (P5)
│   ├── tools/                             # MIGRATED — each existing tool moves here
│   │   ├── search_crm/
│   │   │   ├── manifest.yaml
│   │   │   ├── handler.py
│   │   │   ├── render.py
│   │   │   └── canonical_queries.yaml     # Phase B (empty stub in Phase A)
│   │   ├── get_record/
│   │   ├── request_human_review/
│   │   └── generate_chart/
│   └── workflows/                         # MIGRATED — the one workflow moves here
│       └── weekly_pipeline_review/
│           ├── workflow.yaml
│           ├── handler.py                 # the aggregate_pipeline_views handler
│           ├── render.py
│           └── canonical_queries.yaml
├── orchestrator/
│   ├── tools.py                           # unchanged contract; mark legacy helpers deprecated
│   ├── builtin_tools.py                   # DELETED — content lives in pebble/chisel/tools/
│   ├── planner.py                         # CHANGED — tags surfaced in tool list (F5)
│   └── ... (other orchestrator files unchanged)
├── workflows/                             # DELETED — content lives in pebble/chisel/workflows/
├── handlers/
│   └── streaming.py                       # CHANGED — side-effect imports replaced
└── router.py                              # CHANGED — _SLASH_COMMANDS populated from Chisel

financial_forecasting/frontend-v2/
└── src/pages/chisel/                      # Phase C — NEW
    ├── ChiselPage.tsx
    ├── ManifestBrowser.tsx
    ├── SchemaEditor.tsx
    ├── WorkflowComposer.tsx
    └── EvalRunner.tsx

tasks/
├── pebble-chisel-scoping.md               # DONE (this branch)
└── pebble-chisel-plan.md                  # THIS DOC
```

**Why `pebble/chisel/` (sub-package) over `chisel/` (sibling):** Test infrastructure (`pebble/tests/`), the existing test patterns, and the existing import paths all live under `pebble/`. Co-locating saves a per-import rewrite and keeps `pyproject.toml` simpler. If Chisel ever spins out to PyPI, moving is a `git mv` and an import rewrite — cheap.

---

## §3 — Manifest schema

Two declarative artifacts. Both are Pydantic-validated at autoload; invalid manifests fail loud with file path + line number.

### 3.1 — `manifest.yaml` (tools)

```yaml
# Required
name: fetch_account_health             # str; matches parent dir; [a-z][a-z0-9_]{2,63}
kind: tool                              # literal: "tool"
version: "1.0.0"                        # semver string
description: |                           # 1–1024 chars; the planner's only guide
  Compute health score and risk flags for a Salesforce account.
  Use after search_crm finds an account; pass the account_id.

# Required (handler binding)
input_model: HealthArgs                  # str; class name inside handler.py (Pydantic BaseModel)

# Optional but recommended
tags: [account, read-only, financial]    # list[str]; surfaced to the planner (F5 fix)
cost_estimate_usd: 0.001                 # float; pre-flight budget estimate
requires_human: false                    # bool; True → halt for confirm card
output_kind: prose                       # literal: prose | chart | checkpoint | none

# Renderer (one of)
renderer:
  template_file: render.md.j2            # GUI-authorable Jinja2 markdown
  # OR
  python: render.py:render_fn            # engineer-authorable; function returns str
  # OR (when output_kind != prose)
  pipeline: chart                        # delegate to renderer._collect_charts

# Security / governance (P-from-§7.5)
requires_permission: use_pebble_research # str; Sprint-12 permission name (snake_case)
scope: global                            # global | "<org_id>"; default global (P9)
audit_class: read                        # read | write; informs scratchpad tagging

# Eval (Phase B; empty stub in Phase A)
canonical_queries: []                    # see §5.1 for schema
```

Backed by `pebble/chisel/manifest.py::ToolManifest` (Pydantic), so the same schema validates the file on disk AND drives the GUI's form fields in Phase C.

### 3.2 — `workflow.yaml` (workflows)

```yaml
name: weekly_pipeline_review
kind: workflow
version: "1.0.0"
description: |
  Three-view pipeline review: at-risk + stale + coverage.
tags: [workflow, pipeline]

# Routing
slash_command: /pipeline                 # str | null; null = registered tool only
intent: workflow_weekly_pipeline_review  # str; populates RouteResult.intent

# Default args for the slash-command path
default_args:
  days_to_close: 30
  days_no_activity: 60
  top_n_coverage: 10

# Composition — one of:
# (a) Declarative steps for the GUI-authored case
steps:
  - tool: aggregate_pipeline_views
    args: "$default_args"                # literal placeholder; runtime substitutes
    expected_shape: "summary text + 3 ChartSpec dicts"
    success_criteria: "open_count is reported; charts non-empty when there's data"
# OR (b) Python build_plan for advanced compositions
# build_plan: build_plan.py:build         # signature: (default_args, user_query) -> Plan

# Governance
requires_permission: use_pebble_research
audit_class: read
canonical_queries: []
```

A workflow's `aggregate_*` handler still lives in the workflow dir's `handler.py` (treated as an internal tool by the registry).

---

## §4 — Phase A: Framework (~2 weeks, one PR)

### 4.1 — `pebble/chisel/manifest.py` — Pydantic schemas

- `ToolManifest(BaseModel)`: every field in §3.1. Validators: name regex, semver string, output_kind enum, renderer cross-validation (exactly one of `template_file` / `python` / `pipeline`), `scope` is `global` or a known org_id.
- `WorkflowManifest(BaseModel)`: every field in §3.2. Validator: exactly one of `steps` or `build_plan` is set; `slash_command` regex is `^/[a-z][a-z0-9-]+$`.
- `CanonicalQuery(BaseModel)`: see §5.1.
- One top-level loader: `load_manifest(path: Path) -> ToolManifest | WorkflowManifest` that detects kind from `kind:` field. Raises `ManifestError(path, line, msg)` on validation failure.

### 4.2 — `pebble/chisel/schema.py` — Pydantic → strict JSON Schema (P1 fix)

```python
def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Emit JSON Schema from a Pydantic model with additionalProperties=False
    injected at every type:object node. Matches the strictness of the legacy
    make_input_schema(additional_properties=False) default.
    """
    schema = model.model_json_schema()
    _inject_strict(schema)   # recurse through properties/items/$defs
    return schema
```

`_inject_strict` walks the schema and sets `additionalProperties: False` on every `{"type": "object", ...}` node that doesn't already have it explicit. Test invariant: round-trip a representative Pydantic model and assert no object node is permissive.

### 4.3 — `pebble/chisel/handler_adapter.py` — wraps user `run` into the existing `ToolResult` contract (P2 fix)

User writes:

```python
# pebble/chisel/tools/fetch_account_health/handler.py
from pydantic import BaseModel
from pebble.chisel import HandlerContext

class HealthArgs(BaseModel):
    account_id: str

async def run(args: HealthArgs, ctx: HandlerContext) -> dict:
    return {"health_score": 0.8, "at_risk": False, "account_id": args.account_id}
```

Chisel wraps it:

```python
def wrap_handler(manifest, handler_fn, input_model):
    async def wrapped(args: dict, ctx: ToolContext) -> ToolResult:
        started = time.perf_counter()
        try:
            typed = input_model.model_validate(args)   # late safety net; planner already validated
        except ValidationError as e:
            return ToolResult(step_id=uuid4(), tool=manifest.name, ok=False,
                              error=f"{manifest.name}: invalid args — {e}")
        try:
            data = await handler_fn(typed, _adapt_ctx(ctx, manifest))
        except Exception as e:
            logger.exception("chisel.handler.failed tool=%s", manifest.name)
            return ToolResult(step_id=uuid4(), tool=manifest.name, ok=False,
                              error=f"{type(e).__name__}: {e}",
                              duration_ms=_ms_since(started))
        return _to_tool_result(manifest, data, started)
    return wrapped
```

`HandlerContext` is a thin wrapper around `ToolContext` exposing only what handlers should touch (`user_email`, `conversation_id`, `org_id`, `http_client`, plus convenience helpers like `await ctx.cite("sf_account", account_id)`). `_to_tool_result` accepts either:
- A raw dict → wrapped with `ok=True, data=...`
- A `ChiselResult(data=..., citations=..., extra_cost_usd=...)` named tuple for richer cases

This is most of the per-tool boilerplate kill — `search_crm`'s handler today is 78 lines (`builtin_tools.py:48-125`), of which ~50 lines are ToolResult construction, exception trapping, and duration tracking. Post-Chisel, the same handler is ~15 lines.

### 4.4 — `pebble/chisel/autoload.py` — discovery + register pipeline

```python
def autoload(registry: ToolRegistry | None = None, root: Path | None = None) -> AutoloadReport:
    """Walk pebble/chisel/{tools,workflows}/ and register everything onto
    `registry` (default: DEFAULT_REGISTRY). Idempotent. Returns a structured
    report (counts, errors) for the CLI and the GUI.
    
    P4: registry argument supports test isolation — tests instantiate
    a fresh ToolRegistry and pass it here.
    """
```

Discovery: glob `pebble/chisel/{tools,workflows}/*/manifest.yaml` (and `workflow.yaml`). Skip dirs starting with `_`.

For each manifest:
1. Validate against Pydantic schema → load `ToolManifest` or `WorkflowManifest`
2. Import `handler.py` via `importlib.util.spec_from_file_location` (so the handler dir doesn't need to be on `sys.path`)
3. Resolve `input_model` to a Pydantic class on the imported module
4. Build the strict JSON Schema (`schema.strict_json_schema(input_model)`)
5. Build the wrapped handler (`handler_adapter.wrap_handler(...)`)
6. Build the `ToolSpec` and `registry.register(spec)`
7. For workflows: also populate `chisel._SLASH_COMMANDS[manifest.slash_command] = (2, manifest.intent)` and `chisel._WORKFLOW_DISPATCH[manifest.intent] = build_plan_factory`

`AutoloadReport`: `{ "tools_registered": [...], "workflows_registered": [...], "errors": [...] }`. Used by the CLI for human output and by the GUI's `/api/chisel/health` endpoint.

### 4.5 — `pebble/chisel/rbac.py` — permission enforcement

```python
async def enforce_permission(manifest, ctx: ToolContext) -> None | ToolResult:
    """Called by handler_adapter.wrap_handler before invoking the user's run().
    Returns a ToolResult(ok=False) when the originating user lacks the
    permission named in manifest.requires_permission. Returns None on pass.
    """
```

Implementation: looks up Sprint-12's permission table via the existing `pebble.permissions` module (the one Sprint-12 will land). Until Sprint-12 ships, the implementation is a stub that checks an env-flag allowlist (`PEBBLE_CHISEL_RBAC_BYPASS_USERS`); we leave a `# TODO(sprint12): replace stub` comment with file:line. Test the stub path + the future path behind a feature flag.

### 4.6 — `pebble/chisel/lints.py` — static guardrails

Run at autoload time on each handler.py:

- **No bare `import httpx`** — handlers must use `ctx.http_client`. AST-walk; fail registration if `httpx.get/post/...` is called directly.
- **No `os.environ` reads** — handlers must use injected config. Same AST pattern.
- **Async-only `run`** — defensively check `inspect.iscoroutinefunction(run)`; ToolRegistry already does this but we want the failure to point at the manifest path, not the registry line.
- **`HealthArgs` references handler.py** — the `input_model` named in manifest must be a `BaseModel` subclass importable from the handler module.

Lint failures produce a structured `LintError(manifest_path, kind, msg)`. In dev, `chisel reload` reports them; in CI, `chisel validate` (called by pytest fixture) raises on any.

### 4.7 — `pebble/chisel/cli.py` — engineer-facing CLI

```
chisel scaffold <name>           # P10: write manifest+handler+test scaffold
chisel validate [<name>]         # run lint + manifest validation across all (or one)
chisel reload [<name>]           # unregister + re-register one or all tools
chisel list                      # print registered tools + workflows
chisel eval <name>               # Phase B
chisel mcp-serve                 # explicitly not in v1 — print "deferred"
```

Entry-point registered in `pyproject.toml`: `[project.scripts] chisel = "pebble.chisel.cli:main"`.

`chisel scaffold fetch_account_health`:
- creates `pebble/chisel/tools/fetch_account_health/`
- writes a `manifest.yaml` with name + description placeholders + `input_model: Args`
- writes a `handler.py` with `class Args(BaseModel): ...` + `async def run(args, ctx): return {}`
- writes a `handler_test.py` with one passing happy-path test + one failing-by-default validation test
- prints next steps

### 4.8 — `pebble/chisel/reload.py` — hot-reload safety (P5)

`registry.invoke` reads from `self._specs` dict on every call. To make in-flight calls safe across a reload:

1. Adopt **snapshot-per-request** in the executor. `Executor.__init__` takes `registry`; we change it to take `registry_snapshot: dict[str, ToolSpec]` materialised at request entry. The orchestrator's `_execute_with_events` (`chat_orchestrator.py:369-386`) builds the snapshot from `self.registry.iter_specs()` once per `run_stream`. (Pure addition; the registry stays the same.)
2. `chisel reload <name>` then does `unregister(name); register(new_spec)` on the live registry, knowing in-flight executions are already locked to the prior snapshot. Next user turn picks up the new spec.

Adds ~10 lines to `chat_orchestrator.py`. Documented in plan-level risk register (§9).

### 4.9 — `pebble/orchestrator/planner.py` — surface tags (F5)

The planner's `_format_tool_list` (`planner.py:443-459`, per Pass-1 verification) builds the tool-list section of the system prompt by iterating `self.registry.iter_specs()`. Today it pulls `name`, `description`, `input_schema`. Change: also pull `tags`, and inject a per-tag hint block at the bottom of the system prompt:

```
Available tools:
  - search_crm [tags: account, contact, search] — ...
  - fetch_account_health [tags: account, read-only, financial] — ...

Tool selection hints:
  - tags including "write" → prefer reading before writing; use request_human_review first.
  - tags including "expensive" → use only when cheaper alternatives are insufficient.
  - tags including "workflow" → these are pre-baked aggregations; prefer them over assembling primitives yourself.
```

Per-tag hint copy lives in `pebble/orchestrator/planner_prompts.py` (new) so it's not buried in a multi-line f-string.

### 4.10 — Migration of existing tools + workflows (P3)

The Phase A PR moves and rewrites the 4 tools + 1 workflow. Per-tool migration:

**search_crm** (`pebble/orchestrator/builtin_tools.py:48-172` → `pebble/chisel/tools/search_crm/`):
- `manifest.yaml`: name, description (verbatim from current spec), tags `[search, crm]`, cost_estimate_usd: 0.0, input_model: SearchArgs, requires_permission: use_pebble_research, output_kind: prose, renderer.python: render.py:render_search
- `handler.py`: SearchArgs Pydantic model (query: str, types: list[str] | None, limit: int = 8), `async def run(args, ctx)` returns dict with items/grouped/total_count
- `render.py`: extracted from `renderer.py:_render_search_crm` (renderer.py:263-288)
- `canonical_queries.yaml`: stub (`[]` in Phase A)

Repeat for `get_record`, `request_human_review`, `generate_chart`.

**weekly_pipeline_review workflow** (`pebble/workflows/weekly_pipeline_review.py` → `pebble/chisel/workflows/weekly_pipeline_review/`):
- `workflow.yaml`: name, slash_command: /pipeline, intent: workflow_weekly_pipeline_review, default_args, steps with the one tool, requires_permission: use_pebble_research
- `handler.py`: the aggregate_pipeline_views handler from `weekly_pipeline_review.py:_handle_aggregate_pipeline_views`
- `render.py`: extracted from `renderer.py:_render_aggregate_pipeline_views`
- `canonical_queries.yaml`: stub

**Files DELETED in this PR:**
- `pebble/orchestrator/builtin_tools.py` — content moved
- `pebble/workflows/weekly_pipeline_review.py` — content moved
- `pebble/workflows/__init__.py` — replaced by autoload
- `pebble/orchestrator/renderer.py`: only the per-tool `_render_search_crm`/`_render_get_record`/etc. functions are removed; `_render_completed`, `_render_pre_flight`, `_collect_charts`, etc. stay. `_RENDERERS` dict becomes `chisel.build_renderer_registry()` populated at autoload time.

**Files CHANGED in this PR:**
- `pebble/handlers/streaming.py:62-68`: replace 6 lines of side-effect imports + the `_workflows` import with `from pebble import chisel; chisel.autoload(DEFAULT_REGISTRY)` at app-init time (not at module import — call from FastAPI's lifespan handler so test imports don't blow up if a manifest is malformed).
- `pebble/handlers/streaming.py:250-261`: `_build_workflow_plan_for_intent(intent, user_query)` becomes a one-liner `return chisel.dispatch_workflow(intent, user_query)`.
- `pebble/router.py:91-97`: `_SLASH_COMMANDS = chisel.slash_command_map()` (computed lazily on first call; cached).
- `pebble/orchestrator/planner.py:443-459`: tag surfacing per §4.9.
- `pebble/orchestrator/renderer.py`: per above.

**Tests touched:**
- `pebble/tests/test_orchestrator_builtin_tools.py`: split into per-tool test files at `pebble/chisel/tools/<name>/handler_test.py`. The original file becomes a thin re-import to preserve test discovery for any external test runner reference.
- `pebble/tests/test_workflows_weekly_pipeline_review.py`: moves to `pebble/chisel/workflows/weekly_pipeline_review/handler_test.py`.
- `pebble/tests/test_renderer.py`: per-tool render tests move to per-tool test files; orchestrator-level render tests stay.
- New: `pebble/chisel/tests/test_autoload.py`, `test_handler_adapter.py`, `test_schema_strictness.py` (P1), `test_lints.py`, `test_rbac_stub.py`, `test_reload.py`, `test_cli_scaffold.py`.

### 4.11 — Phase A PR scope summary

- New code: ~800 lines (framework + tests).
- Deleted code: ~600 lines (legacy builtin_tools, workflows package, render branches).
- Net: small. The win is structural, not LoC.
- Risk: high blast radius (touches the import-time tool-loading path). Mitigated by: (a) keeping `pebble.orchestrator.tools` contract unchanged, (b) the existing pytest suite is the regression net — every test must still pass, (c) manual smoke against `/pipeline` slash command + a natural-language L1 query before merge.

---

## §5 — Phase B: Eval harness (~1 week, second PR)

### 5.1 — `canonical_queries.yaml` schema

Per tool/workflow dir. Validated by `CanonicalQuery(BaseModel)` in `pebble/chisel/manifest.py`:

```yaml
- name: account-health-by-id              # str; unique within file
  query: "How healthy is account 001XY?"  # str; the user-visible question
  expected_plan:                           # list; one PlanStep matcher per item
    - tool: fetch_account_health
      args_includes:
        account_id: "001XY"                # subset match, not equality
  expected_prose_includes: ["health"]      # substrings the prose must contain
  expected_prose_excludes: ["error"]       # substrings the prose must NOT contain
  max_cost_usd: 0.01                       # planner+executor budget cap
  notes: |                                 # free text for the author
    Catches the case where the planner skips fetch_account_health and
    only does search_crm.
```

Assertions are intentionally loose on plan order (workflows may have multi-step plans) but strict on tool selection and arg shape. Pose changes are detected via substring inclusion/exclusion, not regex or full-text equality — avoids brittleness from minor template tweaks.

### 5.2 — `chisel eval` runtime

```python
# pebble/chisel/eval.py
async def run_eval(manifest_path: Path, *, live: bool, client) -> EvalResult:
    """For each canonical_query in <manifest_path>'s canonical_queries.yaml:
       1. Construct a Planner with the live registry (or a stub if --no-live).
       2. Call planner.plan(query) — capture the Plan.
       3. Assert Plan against expected_plan.
       4. Run the plan through the executor with a Recorder that captures
          tool calls + costs.
       5. Render to prose. Assert against expected_prose_*.
       6. Aggregate pass/fail/cost.
    """
```

CLI: `chisel eval [<tool_name>]` runs all manifests or one. Exits 1 if any canonical query fails.

### 5.3 — pytest integration (P12 + test surface)

```python
# pebble/chisel/tests/test_eval_canonical.py
@pytest.mark.parametrize("manifest_path", _discover_manifests())
@pytest.mark.eval                                 # custom marker
async def test_canonical_queries(manifest_path):
    if not os.getenv("ANTHROPIC_API_KEY"):
        pytest.skip("eval requires ANTHROPIC_API_KEY")
    result = await chisel.eval.run_eval(manifest_path, live=True, client=...)
    assert result.passed, result.failure_report()
```

The `eval` marker is opt-out by default (`pyproject.toml: addopts = "-m 'not eval'"`). CI workflow adds a separate job that runs `pytest -m eval` only on PRs targeting `main` (cheaper than on every push). Secret: `ANTHROPIC_API_KEY` already exists in the Pebble CI per existing tests; verify on first job run.

### 5.4 — Phase B PR scope summary

- New code: ~300 lines.
- Risk: low (additive, doesn't change runtime).
- Done state: `pytest -m eval` exercises every canonical query; failing planner-prompt changes break the build before merge.

---

## §6 — Phase C: GUI builder (~3–4 weeks, third PR — likely split into FE/BE sub-PRs)

### 6.1 — FastAPI endpoints

All under `/api/chisel/*`. Auth via existing Pebble auth middleware (session cookies, `withCredentials: true` — corrected from JWT per §7.5 P12 verification). Permission gate via `chisel.rbac.enforce_endpoint_permission(request, required="chisel_read"|"chisel_write"|"chisel_write_code")`.

| Method + Path | Permission | Purpose |
|---|---|---|
| `GET /api/chisel/manifests` | `chisel_read` | List all manifests with summary fields |
| `GET /api/chisel/manifests/<kind>/<name>` | `chisel_read` | Read one manifest with full body |
| `POST /api/chisel/manifests/<kind>/<name>/validate` | `chisel_read` | Dry-run validation (Pydantic + lint), returns errors |
| `PUT /api/chisel/manifests/<kind>/<name>` | `chisel_write` | Save a manifest.yaml (Python files stay file-system-only) |
| `POST /api/chisel/reload` | `chisel_write` | Re-autoload the registry |
| `GET /api/chisel/eval/<name>` | `chisel_read` | Stream eval results for one tool |
| `POST /api/chisel/eval` | `chisel_read` | Stream eval results for all (SSE) |
| `GET /api/chisel/health` | `chisel_read` | Last autoload report (errors, counts) |

Endpoints live in `pebble/chisel/routes/` (new), registered with the FastAPI app in the existing `pebble/main.py`.

**Code editing is explicitly NOT supported via API.** Handler/render files are read-only over HTTP. A `?include_files=true` query on GET returns the raw text of `handler.py` and any render files for in-GUI viewing; PUT only accepts `manifest.yaml` content.

### 6.2 — React/TS frontend

Stack: existing `frontend-v2` reality (React 19, Vite, Tailwind, custom UI primitives in `src/components/ui/`, axios with `withCredentials: true`). No new dependencies — we use the same primitives `Pebble.tsx` uses today.

New pages under `financial_forecasting/frontend-v2/src/pages/chisel/`:
- `ChiselPage.tsx` — three-column shell: list (left) | editor (centre) | inspector/eval-runner (right). Same layout as `Pebble.tsx`.
- `ManifestBrowser.tsx` — searchable list of tools + workflows; filter by kind/tag/permission.
- `SchemaEditor.tsx` — form-driven manifest editor. Maps Pydantic field types → form controls (string → input, int → number, list[str] → tag picker, enum → dropdown). Pulls the field shape from `GET /api/chisel/manifests/<kind>/<name>?include_schema_shape=true`.
- `WorkflowComposer.tsx` — declarative workflow.yaml editor: slash-command field, intent field, step list (each step picks an existing tool + supplies args), default_args.
- `EvalRunner.tsx` — runs canonical queries; shows plan diff + prose diff per query.
- `services/chiselApi.ts` — axios wrapper for the eight endpoints, reusing `lib/api.ts`'s instance.

Routes registered in `src/App.tsx`: `<Route path="/chisel/*" element={<ChiselPage />} />` inside the `<AuthGate><AppShell>` wrapper.

### 6.3 — Save flow

1. User edits manifest fields in `SchemaEditor`. Local state.
2. Save → `POST /api/chisel/manifests/<kind>/<name>/validate` first. Surface validation errors inline.
3. If valid → `PUT /api/chisel/manifests/<kind>/<name>` writes the YAML to disk (relative to repo).
4. Optimistic UI update.
5. Background: `POST /api/chisel/reload` triggers in-process reload. Snapshot-per-request (§4.8) makes this safe.
6. Eval-on-save (optional toggle): `POST /api/chisel/eval` for this manifest only; show pass/fail.

Workflow authoring follows the same flow, posting workflow.yaml.

### 6.4 — Handler/render code surface

Per §3.1, the GUI displays `handler.py` and `render.py`/`render.md.j2` files **read-only** in a syntax-highlighted block with a "Copy" button and a `vscode://file/<absolute-path>` deep-link. The "Open in IDE" deep-link is the only path to edit code. Code changes land via PR.

Rationale: Production discipline. Letting non-engineers (or engineers under time pressure) ship Python from a web UI bypasses code review and CI. v1.1 may revisit once Phase B's eval coverage is mature enough to act as a gate.

### 6.5 — Phase C PR scope summary

- New backend code: ~600 lines (endpoints, RBAC wiring, validation hooks, SSE eval streamer).
- New frontend code: ~1,500 lines TS/TSX.
- Risk: medium (new auth-gated endpoints; new persistence-on-disk path). Mitigated by: (a) all writes go through the same Pydantic validators as autoload, (b) `chisel write_code` permission is deliberately not granted by default — Sprint-12 RBAC must explicitly grant it.

---

## §7 — Resolution of P1–P14 from `pebble-chisel-scoping.md §7.5`

| # | Topic | Resolution in this plan | Section |
|---|---|---|---|
| P1 | Pydantic strictness regression | `pebble/chisel/schema.py::strict_json_schema` injects `additionalProperties: false` at every object node | §4.2 |
| P2 | Handler signature wrapper | `pebble/chisel/handler_adapter.py::wrap_handler` constructs ToolResult around the user's `async def run(args, ctx) -> dict | ChiselResult` | §4.3 |
| P3 | Migration blast radius | Enumerated: `streaming.py` (2 sites), `router.py`, `workflows/__init__.py`, `orchestrator/builtin_tools.py` (DELETED), `orchestrator/renderer.py` (per-tool branches DELETED), tests redistributed | §4.10 |
| P4 | Autoload + test isolation | `autoload(registry=None, root=None)` — tests pass an isolated registry | §4.4 |
| P5 | Hot-reload safety | Snapshot-per-request in `Executor`; `chisel reload` operates on the live registry, in-flight executions read from their snapshot | §4.8 |
| P6 | Render template language | Manifest accepts EITHER `renderer.template_file: render.md.j2` (Jinja2) OR `renderer.python: render.py:fn` | §3.1, §4.10 |
| P7 | Tools without per-tool renderers | `output_kind: chart | checkpoint | none` + `renderer.pipeline: chart` delegates to existing `_collect_charts` | §3.1 |
| P8 | Variable-cost tools | v1: single-float `cost_estimate_usd`. YAML shape leaves room (`cost_estimate: { fixed: 0.001 }` not yet — single float for now, structured-cost is v1.1 if demand emerges) | §3.1 |
| P9 | Multi-tenant scope | `scope: global | <org_id>` field; v1 supports global only; org-scoped autoload is v1.1 | §3.1 |
| P10 | Test scaffolding | `chisel scaffold <name>` writes manifest + handler + handler_test scaffold | §4.7 |
| P11 | Sprint-11 forward-compat | ToolResult gains `tool_version: str | None` filled by Chisel runtime; scratchpad consumes when Sprint-11 lands | §4.3 (in `_to_tool_result`) |
| P12 | Eval-harness CI secrets | `pytest -m eval` opt-out marker; separate CI job pre-merge; `ANTHROPIC_API_KEY` from existing Pebble CI secrets | §5.3 |
| P13 | RBAC naming convention | **Default chosen:** `chisel_read`, `chisel_write`, `chisel_write_code` (snake_case, domain-first, matches `use_pebble_research`). Awaiting your sign-off. | §6.1 |
| P14 | README + CHANGELOG | Each phase's PR updates `pebble/README.md` (section "Authoring tools and workflows") + repo-root `CHANGELOG.md`. Phase C also touches `financial_forecasting/frontend-v2/README.md`. | §10 |

---

## §8 — Test plan (cross-phase summary)

| Layer | Phase | Tests |
|---|---|---|
| Manifest schema | A | `test_manifest_schema.py`: valid manifests parse; invalid (missing name, bad regex, missing required-when-X) fail with line-numbered errors |
| Pydantic→JSON strict | A | `test_schema_strictness.py`: every object node has `additionalProperties: false`; round-trip test with a representative model that uses nested objects |
| Handler adapter | A | `test_handler_adapter.py`: dict→Pydantic happy + invalid; exception in user code → ToolResult ok=False; duration recorded; `tool_version` set |
| Autoload | A | `test_autoload.py`: discovers all 5 migrated manifests; idempotent; registry argument honored; one malformed manifest doesn't poison the others |
| RBAC stub | A | `test_rbac_stub.py`: bypass list works; missing permission returns ToolResult ok=False; future Sprint-12 hook fires correctly |
| Lints | A | `test_lints.py`: catches `import httpx`, `os.environ` reads, non-async run; passes on the 4 migrated handlers |
| CLI scaffold | A | `test_cli_scaffold.py`: creates the dir, files run pytest cleanly, no name collisions |
| Reload safety | A | `test_reload.py`: reload during simulated in-flight call doesn't change the snapshot the in-flight call sees |
| Planner tags | A | `test_planner_tags.py`: tool-list section includes tags; per-tag hints appear; previously-passing planner tests still pass |
| Each migrated tool | A | The 4 tool test files at their new paths; assert behavioural parity vs the pre-migration tests (recorded in this PR's diff) |
| End-to-end smoke | A | `test_e2e_pipeline_slash.py`: /pipeline still runs the weekly workflow with Chisel-loaded tools |
| Eval framework | B | `test_eval_framework.py`: canonical_queries.yaml schema; assertion logic for plan + prose |
| Eval-gated CI | B | Separate workflow job `eval-gate.yml` runs `pytest -m eval` on PRs |
| GUI endpoints | C | `test_api_chisel.py`: all 8 endpoints, auth gates, permission failures, validate-before-write |
| Workflow YAML CRUD | C | Round-trip a workflow.yaml through validate + PUT + reload + eval |
| Frontend | C | Vitest tests for `SchemaEditor`, `WorkflowComposer`, `EvalRunner`; user-event flows for save-on-valid, save-blocked-on-invalid |
| GUI smoke | C | A manual checklist: create a new tool via GUI, save, see it appear in `/pebble` planning, run eval |

---

## §9 — Risk register

| Phase | Risk | Mitigation |
|---|---|---|
| A | Migration breaks a tool subtly (renderer output drifts) | Capture before/after rendered output for the 4 tools' canonical inputs as a fixture in the PR; assert byte-equality |
| A | Autoload import error blocks app start | `autoload()` returns a report; in production, log errors but don't crash — start with whatever loaded successfully, surface errors at `/api/chisel/health` |
| A | Snapshot-per-request adds latency | Snapshot is `dict(self._specs)` — O(n) where n < 30. Negligible. Measure on the smoke test. |
| A | `chisel reload` race with `PEBBLE_USE_ORCHESTRATOR=on` long-running plans | Documented as dev-only; production reload requires app restart. Phase C's `POST /api/chisel/reload` triggers a fresh-snapshot acquisition on next request, which is the safe equivalent. |
| B | Eval flakiness from LLM nondeterminism | Use `temperature=0` for the planner during eval; the planner today already uses 0 (verify in `planner.py`) |
| B | CI cost from eval runs | Mark eval as opt-out by default; only run on pre-merge PRs to main |
| C | A `chisel_write` user breaks autoload by saving invalid YAML | Validation runs server-side BEFORE the PUT lands on disk; even if it slipped through, the next reload errors and the UI surfaces the failed manifest |
| C | GUI confuses workflow authors when a workflow needs custom Python | Detect `build_plan.py` presence; show a "this workflow has custom Python" banner with the IDE deep-link; GUI shows the YAML half but disables save until a flag is set |
| C | Session-cookie auth breaks when the platform integration switches to JWT | Auth is centralized in `pebble/main.py` middleware; swap path is one place; documented in §10 forward-compat |

---

## §10 — Forward-compatibility checklist

Stays valid through the future platform integration (Node/Express + JWT + platform stack):

- Manifest format: YAML + JSON Schema. Language-agnostic.
- Handler interface: async fn taking dict + ctx, returning dict. Trivial Node.js port (one file per handler).
- Persistence: filesystem in v1. If we later need DB-backed manifests, target `bedrock.chisel_*` tables in segundo-db (per `[[reference-segundo-db]]` memory).
- Auth: centralized in `pebble/main.py` middleware. Swap from session cookies to JWT/Bearer happens in one place.
- Frontend: built using `frontend-v2`'s existing components (Tailwind + custom primitives). Components compose into whatever shell the platform integration deploys.
- Tool versioning: `version:` field already in the manifest. Scratchpad-recorded once Sprint-11 lands. Rename path is `deprecated_aliases:` (deferred to v1.1).

Docs to update per phase:
- Phase A: `pebble/README.md` "Authoring tools and workflows" section; root `CHANGELOG.md` entry.
- Phase B: same files; new section "Running eval".
- Phase C: same + `financial_forecasting/frontend-v2/README.md` adds the Chisel page route.

---

## §11 — Decisions deferred to implementation (you can redirect any of these now)

These are calls I'd make at code-write time unless you object first.

1. **P13 RBAC names:** `chisel_read`, `chisel_write`, `chisel_write_code`. Snake_case, domain-first. Matches `use_pebble_research`.
2. **Manifest YAML library:** `PyYAML` (already in `requirements.txt` for the existing test fixtures — verify before locking; ruamel.yaml as fallback if comment-preservation matters for GUI saves).
3. **Pydantic version:** stick with whatever Pebble already uses. (`pyproject.toml` should already pin it.)
4. **CLI framework:** `argparse` over Click — fewer deps, same ergonomics for the ~6 subcommands.
5. **GUI form library:** none. The existing `frontend-v2` doesn't use one; build with controlled inputs + the existing `Tag`/`Drawer`/`Tooltip` primitives.
6. **Eval prose-assertion language:** start with substring includes/excludes; deliberately NOT regex (too easy to write fragile assertions). Add regex if real-world eval shows it's needed.
7. **`HandlerContext` shape:** thin wrapper over `ToolContext` (read-only properties) plus a `cite(entity_type, entity_id, title=None)` helper that appends to the result's citations. `ctx.http_client` is exposed as the raw httpx client (no extra wrapping in v1).
8. **Migration sequencing within Phase A's PR:** land the framework first as a no-op (no manifests yet, autoload is a no-op), then migrate `request_human_review` (simplest — no I/O), then `generate_chart`, then `get_record`, then `search_crm`, then `weekly_pipeline_review`. Six commits, one PR.
9. **Bypass list for the RBAC stub:** `PEBBLE_CHISEL_RBAC_BYPASS_USERS` env var, comma-separated emails. Defaults to whoever's in `PEBBLE_CHAT_ALLOWED_EMAILS` if that env exists. Replaced by Sprint-12 hooks when those land.
10. **Frontend route nesting:** `/chisel`, `/chisel/tools/<name>`, `/chisel/workflows/<name>`, `/chisel/eval/<name>`.

---

## §12 — What's next (after plan approval)

1. **You review this plan.** Redirect any §11 default, change any phase scope, push back on any assumption.
2. I update §11 + the relevant phase section.
3. We commit both `tasks/pebble-chisel-scoping.md` and `tasks/pebble-chisel-plan.md` to the branch in one commit (per your "hold until plan is written" call).
4. I enter `EnterPlanMode` (or skip if you prefer working off the plan as-written) for Phase A's PR work — write code, migrate tools, run the full test suite, open the PR.
5. After Phase A merges, repeat for Phase B and Phase C.
