# Chisel — Scoping Document

> **Status:** scope locked. Plan-mode pending user approval.
> **Branch:** `feat/pebble-chisel-scoping` (worktree off `feat/pebble-phase-0`)
> **Verifier:** Claude, 2026-05-11. Load-bearing claims cite file:line and were checked directly against the worktree at this date.

## §-1 — Locked decisions (2026-05-11)

| # | Decision | Choice |
|---|---|---|
| D1 | Audience | **Engineers + non-engineers via GUI builder.** Web UI in the platform stack (React 19 + Vite + Tailwind + shadcn/ui) for visual composition. Engineers retain a Python-file authoring path. |
| D2 | Unit of work | **Tools + workflows.** Both flow through the same Chisel manifest model; workflows auto-generate `build_plan`, slash-command entry, and dispatch hook. |
| D3 | Authoring model | **Hybrid: manifest.yaml + handler.py per tool/workflow.** Pydantic input model inside handler.py is the source of truth for the schema; Chisel auto-generates JSON Schema from it. The manifest is the GUI's editable artifact; the handler is the engineer's editable artifact. |
| D4 | Authoring loop | `chisel reload` CLI + API-triggered hot reload from the GUI. File-watcher deferred to a v1.1 polish item. |
| D5 | Validation/quality | Pydantic-as-schema-source **and** an eval harness with canonical queries → expected plans → expected prose. LLM-as-judge deferred. |
| D6 | Distribution/versioning | Single in-process registry. `version` field in manifest (recorded in scratchpad rows for forward-compat with Sprint-11). No marketplace. |
| D7 | Security/governance | Sprint-12 RBAC integration is non-negotiable. Manifest carries `requires_permission` + `requires_human` + `cost_estimate_usd`. Lint enforces handler use of `ctx.http_client` (audited) not bare `httpx`. |
| D8 | External emit | **None.** No MCP emit, no Skills emit, no MCP consume. Forward-compatibility is to the *internal* platform stack (segundo-db = Postgres + asyncpg + `bedrock` schema; Node/Express target; JWT auth; React+Tailwind+shadcn frontend), not to external agent ecosystems. |

---

## §0 — What is Chisel?

**Working definition.** Chisel is the meta-tool for Pebble. It collapses "author a new tool or workflow" from a multi-file Python+test+wiring chore into a single co-located unit, removes the silent-failure modes that exist today, and (potentially) opens Pebble's capability surface to MCP-compatible consumers.

The Pebble Phase-0 contract is explicit about this need. From `pebble/orchestrator/tools.py:20-21`:

> "Adding a new tool = new file in this package + register at import time. **No core orchestrator changes needed.**"

And from `pebble/workflows/__init__.py:19-21`:

> "v1.0 ships `weekly_pipeline_review` as the worked example. **New workflows = new file in this package + register at import time. No core orchestrator changes needed.**"

That is the *promise*. The *reality* — measured below — is that "new file" is in fact 6–10 files, with several silent-failure modes if you miss one. Chisel's job is to make the promise match the reality.

---

## §1 — Baseline: the current authoring cost (verified May 2026)

Verified by walking `fetch_account_health(account_id: str) → HealthReport` end-to-end against the codebase at `feat/pebble-phase-0`.

### 1.1 — Files I would touch

| # | File | What I add | Mandatory? | Silent-fail if skipped? |
|---|---|---|---|---|
| 1 | `pebble/orchestrator/builtin_tools_health.py` (new) | Async handler, ToolSpec, `register_health_tools()` | Yes | n/a |
| 2 | `pebble/handlers/streaming.py:62-68` | Add `from ..orchestrator import builtin_tools_health as _  # noqa: F401` | Yes — registry depends on import side-effect | **YES** — registry missing the tool, planner can't construct a plan, user sees "I couldn't put together a plan." (`streaming.py:62-66` comment explicitly warns about this) |
| 3 | `pebble/orchestrator/renderer.py` | Add `_render_fetch_account_health()`, add to `_RENDERERS` dict at line 330 | No — generic fallback exists at `renderer.py:222-235, 320-327` | Falls back to `"fetch_account_health: returned health_score, at_risk."` — ugly, not silent |
| 4 | `pebble/tests/test_orchestrator_builtin_tools.py` (or sibling) | Happy path, error path, schema validation, citation shape | Yes (CLAUDE.md "no demos") | No, but PR will be rejected at review |
| 5 | `pebble/tests/test_renderer.py` | Renderer template assertion | Yes if §3 added | No |
| 6 | `pebble/tests/test_orchestrator_chat_orchestrator.py` | End-to-end with stubbed planner emitting a plan that calls this tool | Yes for confidence | No |
| 7 | `pebble/router.py:91-97` `_SLASH_COMMANDS` | Optional: `"/health": (2, "workflow_account_health")` | No | — |
| 8 | `pebble/workflows/account_health.py` (new) + `pebble/workflows/__init__.py` import + `streaming._build_workflow_plan_for_intent` branch | Optional: only if slash command path | No | — |

**Tool-only:** 4–6 files. **Tool + workflow + slash command:** 8–10 files.

### 1.2 — Time

Conservative estimate at production discipline: **4–8 h for a tool, 1–1.5 days for tool+workflow+slash command**. Half of that is wiring and re-reading other tools for the convention; very little is the tool's actual logic.

### 1.3 — Friction points, ranked (verified)

| # | Friction | Severity | Frequency | Where it bites |
|---|---|---|---|---|
| F1 | **Side-effect import in `streaming.py`** | High | Every new module | Forgetting it = registry missing the tool, planner emits no plan. Silent. (`streaming.py:62-68`) |
| F2 | **Schema/handler duplication** | High | Every new tool | JSON Schema dict + handler signature have to agree; nothing checks that. Today: hand-write both via `make_input_schema` (`tools.py:178-196`) and a hand-rolled handler that reads `args["..."]`. |
| F3 | **Renderer template duplication** | Medium | Every new tool | Generic fallback exists but is ugly; production output requires a `_render_<tool>(data)` function and an entry in `_RENDERERS` dict. Easy to forget. |
| F4 | **Workflow has 4 stitching points** | Medium | Every new workflow | (a) ToolSpec, (b) `build_*_plan`, (c) `_SLASH_COMMANDS` entry, (d) `_build_workflow_plan_for_intent` branch. The router (a) and the dispatcher (d) are in different files; staying in sync is manual. |
| F5 | **No planner hints / priority signal** | Medium | Every multi-tool query | Planner only sees `name + description + input_schema` via `to_anthropic_dict()` (`tools.py:68-74`). `ToolSpec.tags` field exists (`tools.py:66`, used by `aggregate_pipeline_views` with `tags=("workflow","pipeline")`) but is **never surfaced** to the planner. Dead field today; obvious Chisel hook. |
| F6 | **No co-located testing pattern** | Medium | Every new tool | Tests live in `test_orchestrator_builtin_tools.py` (handler-level), `test_renderer.py` (template-level), `test_orchestrator_chat_orchestrator.py` (integration). Authors copy-paste from existing tests; no scaffold. |
| F7 | **No eval / golden-query harness** | High (long-tail) | Every prompt-tuning change | Once a tool ships, planner prompt changes can silently re-route queries. No canonical-query-to-expected-plan tests. Drift surfaces only in prod. |
| F8 | **Hot reload story is brittle** | Low day-to-day, High when present | Development | `register()` raises on duplicate names (`tools.py:96-99`). `unregister()` exists (`tools.py:109-111`) but no DX wraps it. Tool edits = process restart. |
| F9 | **No version semantics** | Low near-term, High long-term | Renames/deprecations | Tool name is the identifier in scratchpad rows. Rename a tool, old conversation traces dangle. Future Sprint-11 persistence (`sprint11-pebble-persistence-crm.md`) makes this worse. |

**Bottom line for Chisel's TAM:** F1, F2, F3, F4 are pure boilerplate-elimination wins — declarative spec compiles them down. F5 unlocks better planner behavior (live the dead `tags` field). F6 is template generation. F7 is the biggest qualitative win (catches regressions). F8 and F9 are deferrable.

---

## §2 — Architectural decisions

Eight decisions. The first three are forks the user needs to make; the others I default and recommend.

### D1. **Audience** — load-bearing

**Options:**

- **(a) Engineers only.** Chisel is a Python DX system. Authors write a Python file using a Chisel-provided helper; everything is version-controlled, type-checked, IDE-aware.
- **(b) Engineers + power-user RMs in an IDE.** Same as (a) but ergonomically usable by non-Python-author RMs who can edit YAML/text files. No GUI.
- **(c) Engineers + non-engineers via a GUI builder.** Adds a web UI for visual tool/workflow composition. Major scope expansion.

**What the evidence says.** Personas with authoring responsibility today (from `pebble-bi-architect.md` + `ask-pebble-spec.md`): Pebble Developer (Python), Workflow Author (Python + SQL), Metrics Author (SQL templates), Prompt Specialist, Orchestrator Maintainer. **None of these are non-engineers.** The "how do we teach non-engineers to author tools?" question is named as an open one in `pebble-evolution-roadmap.md` but is not currently a blocker. End users (RMs, execs, PMs) are *consumers*, not authors.

**Recommendation:** (a) — engineers only — for v1. Plan a (b)-compatible YAML overlay for v1.1 if demand emerges. Skip (c) until at least three non-engineer prospective authors raise their hand.

### D2. **Unit of work** — load-bearing

**Options:**

- **(a) Tools only.** Workflows continue to be hand-authored.
- **(b) Tools + workflows.** Chisel handles both. A workflow is a tool with a co-located `build_plan` function and an automatic slash-command + dispatch wiring.
- **(c) Workflows only.** Tools stay hand-authored.

**What the evidence says.** Workflows have 4 stitching points (F4) and grow faster than tools because of the reserved slots in `_SLASH_COMMANDS` (`/digest`, `/at-risk`, `/research` — all commented as reserved at `router.py:93-96`). Tools have higher count per workflow. Skipping workflows in Chisel means F4 stays unsolved; skipping tools in Chisel means F1–F3 stay unsolved.

**Recommendation:** (b) — tools + workflows. They share infrastructure already (workflows register tool specs).

### D3. **Authoring model** — load-bearing

**Options:**

- **(a) Pure declarative (YAML/JSON).** `tool.yaml` declares name + description + schema + handler reference; runtime generates the registration + renderer scaffolding.
- **(b) Pure imperative (Python decorator).** `@chisel.tool` over a normal async function; the decorator handles registration, schema-from-type-hints, renderer co-location.
- **(c) Hybrid — manifest + Python module.** A `chisel/tools/<name>/` directory containing `manifest.yaml` (name, description, tags, version) and `handler.py` (the function) and `render.py` (optional template). Auto-discovered.

**Trade-offs:**

- (a): IDE/type-check support is weak. Forces a separate handler reference mechanism. Easiest path to a future GUI but worst Python ergonomics.
- (b): Best Python DX. Hardest to evolve into multi-language or non-Python authoring. Closest to the Anthropic Agent SDK's `@tool` decorator pattern (`code.claude.com/docs/en/agent-sdk/python`).
- (c): Most ceremony, but it solves discovery (manifest = auto-import side-effect, kills F1). It also gives a clean home for the renderer template and tests, addresses F3 and F6.

**Recommendation:** (c) — hybrid manifest. The manifest is the structural truth (Chisel can introspect it for the eval harness, MCP emit, GUI later); the Python module is the implementation truth (the part engineers actually care about). The manifest-driven loader replaces the side-effect-import pattern at `streaming.py:62-68` — that file becomes one line: `chisel.autoload()`.

### D4. **Authoring loop** — downstream of D1

**Options:**

- **(a) Local file → restart → test.** Today's loop. Cheap, dumb, slow.
- **(b) Local file → hot reload via `chisel reload` CLI.** Uses `registry.unregister()` (already exists at `tools.py:109-111`).
- **(c) Local file → file-watcher hot reload.** Watches the manifest dir; re-registers on change.
- **(d) In-product UI builder with live preview.** Requires D1=(c); out of scope here.

**Recommendation:** (b) — explicit `chisel reload` for v1. (c) is a nice-to-have for v1.1 once the registry has resync semantics. (d) only if D1=(c).

### D5. **Validation & quality** — depth determines tier

**Options (cumulative — pick the highest level):**

- **(a) Schema validation at registration time only.** Current state. JSON Schema is in the spec; planner-passed args validated at the planner→executor boundary.
- **(b) + Pydantic models as schema source-of-truth.** Author writes a Pydantic input model; Chisel generates the JSON Schema from it. Handler receives the typed model directly (or a `.model_dump()` dict for back-compat). Kills F2.
- **(c) + Eval harness / golden-query fixtures.** Each tool ships with a canonical query → expected plan → expected prose triplet. `chisel eval` runs the planner against the canonical query, diffs the plan, diffs the prose. Catches planner drift. Kills F7.
- **(d) + LLM-as-judge for output quality.** Use Haiku to score the prose output against a rubric. Expensive; pairs with (c).

**Recommendation:** (b) + (c) for v1. (d) for v1.1.

### D6. **Distribution & versioning** — defer to later

**Options:**

- **(a) Single in-process registry (today).** Tools live in code. Versioning is git tags.
- **(b) + Per-tool semver in manifest.** `version: 1.2.0`. Scratchpad rows record version. Renames go through `deprecated_aliases:` map.
- **(c) + Marketplace / external registries.** Way out of scope.

**Recommendation:** (a) for v1, plan (b) for v1.1 once Sprint-11 persistence ships and tool-name dangling becomes a real risk (`sprint11-pebble-persistence-crm.md`).

### D7. **Security & governance** — must integrate Sprint-12

**Hard requirements (verified, non-negotiable):**

- Every tool handler receives a `ToolContext` carrying `user_email` (`tools.py:43`). Chisel's authoring helper MUST pass this through; "service principal" handlers must be impossible to author.
- Sprint 12 (`sprint12-pebble-access-control.md`) adds `use_pebble_research` RBAC + per-user daily cost caps. Chisel's manifest needs an optional `requires_permission:` field; Chisel runtime enforces it at the registration → dispatch boundary, not at handler-write time.
- Audit logging happens at the Bedrock layer; Chisel doesn't need to add audit infrastructure, but Chisel-authored handlers MUST go through `crm_bridge` (the audited client) and not raw `httpx`.

**Recommendation:** Chisel's manifest has `requires_permission`, `requires_human`, `cost_estimate_usd` fields. Chisel validates handler code uses `ctx.http_client` (the audited path), not bare `httpx`. Lint check at registration time.

### D8. **Anthropic alignment** — orthogonal lever, big strategic call

**Options (independent — can mix):**

- **(a) Emit Anthropic Skills bundles** (SKILL.md + scripts/). Strategic value: HIGH portability across Claude Code / claude.ai / API / 30+ industry tools (the open SKILL.md standard, `agentskills.io/specification`). **Mismatch:** Skills assume the host has tools; tools are an afterthought in the open spec. Pebble's tool-centric model doesn't map cleanly. Skills are best for *procedures*, not capabilities.
- **(b) Emit MCP servers.** Strategic value: HIGH. Pebble tools become callable from Claude Code, Claude Desktop, Cursor, every Agent-SDK consumer, every MCP client. The Agent SDK's `@tool` decorator already emits in-process MCP servers (`code.claude.com/docs/en/agent-sdk/python`) — we'd be following the canonical pattern. Tool spec is JSON Schema 2020-12 (`modelcontextprotocol.io/specification/2025-11-25/server/tools`) — exact match to what Chisel manifests already need.
- **(c) Consume external MCP servers.** Strategic value: MEDIUM. Lets Pebble light up new capabilities by pointing at any MCP server (Postgres, GitHub, Slack, …) without writing Python. Cost: OAuth 2.1 flow per `modelcontextprotocol.io/specification/2025-11-25/basic/authorization`, consent UX, schema drift. Different scope from (a)/(b).

**Recommendation:** **(b) for v1, defer (a) and (c)**. Rationale:
- (b) is the natural extension of the existing tool model — Chisel manifests already need JSON Schema; MCP's wire format is the same JSON Schema; the Agent SDK proves the pattern. We get external callability nearly free, and it costs the architecture nothing extra.
- (a) is a different mental model (procedures-not-tools). Doable later as an output-format choice, not a primary architecture target.
- (c) is a different scope (it's *consumption*, not *authoring*). It belongs in a separate track ("Bedrock-of-tools") if Pebble wants to be MCP-extensible by customers.

---

## §3 — Three scope tiers (original framing — superseded by §3.5 after answers)

Effort estimates assume one engineer at production discipline (CLAUDE.md "no demos"). All tiers include the Sprint-12 RBAC integration (D7) because it's non-negotiable.

### **Tier 1 — MVP (1.5–2 weeks)**

**Scope:** D1=(a), D2=(b), D3=(c), D4=(b), D5=(a+b), D6=(a), D7=full, D8=none.

- Manifest-driven tool + workflow authoring (`chisel/tools/<name>/manifest.yaml` + `handler.py`).
- `chisel autoload()` replaces side-effect imports in `streaming.py` (kills F1).
- Pydantic-as-schema-source (kills F2).
- Manifest has optional `renderer.py` for per-tool templates (eases F3).
- Workflow manifest auto-generates `build_plan` + slash-command + dispatch hook (kills F4).
- `chisel reload` CLI for hot-reload during dev (eases F8).
- RBAC enforcement at registration → dispatch boundary.
- Tests for the framework + one migrated tool (`search_crm` or `get_record`) as the worked example.

**Out of scope:** Eval harness, MCP emit, tool versioning, GUI, hot-watcher.

**What you get:** Tool authoring drops from 4–8 h to ~30–60 min. Workflow authoring drops from 1–1.5 d to ~1–2 h.

### **Tier 2 — Good (3–4 weeks) — RECOMMENDED**

**Scope:** Tier 1 + D5=(c) + D8=(b) + planner-surface for `tags`.

Adds on top of MVP:

- **Eval harness.** Each Chisel manifest ships a `canonical_queries:` block (e.g., `"show Acme's account health" → expected plan with step[0].tool = fetch_account_health`). `chisel eval` runs the live planner, diffs plan + prose against expectations. Catches planner drift (kills F7).
- **MCP emit.** `chisel mcp-serve` exposes the entire Chisel registry as an MCP server (stdio + Streamable HTTP). Pebble tools become callable from Claude Code, Claude Desktop, Cursor.
- **Planner uses `tags`.** Chisel injects tags into the planner's tool-list, plus per-tag hints in the planner system prompt (e.g., `tags: ("write",)` → "Write-tagged tools require human review; prefer search before write."). Lights up F5.

**Out of scope:** Skills emit, MCP consume, GUI, versioning, hot-watcher.

**What you get:** Tier 1's authoring speedup + a regression net + Pebble becomes an MCP citizen with zero per-tool extra work.

### **Tier 3 — Great (8–10 weeks)**

**Scope:** Tier 2 + D5=(d) + D6=(b) + D1 evolution toward (b) + D4=(c).

Adds on top of Good:

- **LLM-as-judge eval.** Haiku scores prose output against a per-tool rubric.
- **Tool versioning.** `version:` + `deprecated_aliases:` in manifest. Scratchpad rows record version. Rename path through the alias map.
- **YAML overlay for RM-class authors.** D1=(b). Same manifest, simpler "common case" template.
- **File-watcher hot reload.** D4=(c).
- **Skills emit (D8=(a)).** `chisel skill-emit <name>` produces a `SKILL.md` + scripts/ bundle. Useful for proceduralizing common workflows.

**Out of scope:** MCP consume (separate track), full GUI builder (Tier 4).

**What you get:** Skill industrialization. Tool authoring approaches the "30-second" frontier. Real eval coverage.

---

## §3.5 — Revised tier given locked decisions

The GUI-builder audience (D1) and forward-compat-to-platform constraint (D8) push the v1 shape past the original "Good" tier. The new v1 = three cumulative phases shipped as separate PRs against this branch:

### **Phase A — Framework (~2 weeks)**

The engineer-facing foundation. Every later phase depends on this being clean.

- `pebble/chisel/` sub-package: manifest loader, autoload registry hook, Pydantic→JSON Schema bridge, RBAC enforcement, manifest validators (lint), `chisel reload` CLI.
- Migrate the 4 existing tools (`search_crm`, `get_record`, `request_human_review`, `generate_chart`) + the 1 workflow (`weekly_pipeline_review`) to Chisel manifests in the same PR. No coexistence with the legacy registration pattern — production discipline.
- Replace `pebble/handlers/streaming.py:62-68` side-effect imports with a single `chisel.autoload()` call.
- Light up `ToolSpec.tags` in the planner system prompt (kills F5).
- Full test coverage of the framework + migrated tools.

**Done state:** Engineers can drop a `manifest.yaml + handler.py` directory and have a working tool/workflow in ~30 minutes. No GUI yet.

### **Phase B — Eval harness (~1 week)**

The production-discipline gate. Without it, every planner-prompt tweak risks silent regressions.

- `canonical_queries.yaml` per manifest: list of `(query, expected_plan_shape, expected_prose_assertions)`.
- `chisel eval` CLI runs the live planner against each canonical query, diffs results, exits non-zero on regression.
- Integrate with the existing `pebble/tests/` pytest runner so `pytest` catches eval regressions in CI.
- Documented authoring guide for canonical queries (avoid brittleness, focus on plan structure not prose word-for-word).

**Done state:** Planner-prompt changes break the build if they re-route any canonical query.

### **Phase C — GUI builder (~3–4 weeks)**

The non-engineer surface. Lives in the existing Pebble FastAPI app, built in the platform's component library so it ports cleanly when the AI-native learning platform integration lands.

- `/api/chisel/*` FastAPI endpoints (list, read, create, update, validate, reload, run-eval). JWT auth via existing Pebble auth middleware. RBAC: `chisel.read` and `chisel.write` permissions through Sprint-12 RBAC.
- `frontend-v2/src/pages/chisel/` React UI: manifest browser, visual schema editor (Pydantic fields → form fields), workflow composer (drag tools onto a plan, slash command picker), eval runner with diff view. Tailwind + shadcn/ui components per platform stack.
- API-triggered hot reload (`POST /api/chisel/reload`) so GUI saves take effect without restart.
- "Edit handler" surface: for non-engineers, the handler.py is shown read-only with an "Open in Cursor/VSCode" link; for engineers with `chisel.write_code`, a side-effecting code editor (initially Monaco-based; constrained to handler.py / render.py).
- Authoring guardrails: GUI refuses to save a manifest that fails Pydantic validation, lints, or eval golden-query checks.

**Done state:** A non-engineer can compose a new tool or workflow from the GUI, get RBAC-gated permission to save, and see it live in Pebble without an engineer touching code (assuming the handler logic is composable from existing primitives).

### **Total v1 effort: ~6–7 weeks** at production discipline. Phased delivery so the framework lands first (and Pebble immediately benefits), eval lands second (regression net), GUI lands third (extends authoring access).

## §4 — Recommended tier: **Phase A → B → C (cumulative)**

The three-phase shape above is the right shape because:

1. **Phase A is load-bearing under every later phase.** GUI, eval, and any future external emit all need a clean manifest model. Land it first; benefit from it immediately even before B and C.
2. **Phase B before C is the right order.** The GUI is a force multiplier that needs guardrails. Shipping GUI authoring without an eval harness means non-engineers can ship tools that quietly break the planner. Eval lands first; GUI uses it to validate saves.
3. **No external emit is correctly out of scope.** User confirmed Chisel is for inside-Bedrock use. We get back ~1 week of MCP-server-wiring scope and avoid the JSON-RPC + OAuth surface area.
4. **Forward-compat to the platform is baked in, not bolted on.** Manifest is YAML (portable). Handler interface is JSON-in / JSON-out async function (Node.js-portable). Persistence (when added) goes through `bedrock.chisel_*` tables in segundo-db. GUI built in React + Tailwind + shadcn/ui (platform stack). Auth uses JWT Authorization: Bearer. When the AI-native learning platform integration ships, Chisel components port cleanly.
5. **The standing directives (senior-eng bar, no demos, production discipline) are honored** by including B before C and migrating existing tools cleanly rather than coexisting with the legacy pattern.

---

## §5 — The 3–5 most load-bearing open questions

These are the questions whose answers most change the architecture. Each has a recommendation but is a taste call.

1. **D1 Audience.** Engineers only (recommended), engineers + RM-class power users (YAML overlay), or also non-engineers (GUI builder)?
2. **D2 Unit of work.** Tools only, workflows only, or both (recommended)?
3. **D3 Authoring model.** Pure declarative YAML, pure imperative Python decorator, or hybrid manifest+module (recommended)?
4. **D8 Anthropic alignment.** No external emit, MCP-emit only (recommended), MCP-emit + Skills-emit, or MCP-emit + Skills-emit + MCP-consume?

These four taken together pin down the tier. After your answers I'll:
- Update this scoping doc to capture the call.
- Enter plan mode and write the detailed implementation plan to `tasks/pebble-chisel-plan.md`.
- Stop there for your approval before any code.

---

## §6 — Appendix: things deliberately not in this doc

- **Specific package layout, file names, import paths.** Implementation detail; goes in the plan, not the scope.
- **Specific Pydantic / manifest YAML schema.** Detail; goes in the plan.
- **Whether `chisel` is a sub-package of `pebble/` or a sibling.** Detail; default is `pebble/chisel/` to share the test infra.
- **Migration plan for existing tools.** All four current tools (`search_crm`, `get_record`, `request_human_review`, `generate_chart`) + the one workflow (`weekly_pipeline_review`) get migrated to Chisel manifests in the same PR. No parallel coexistence — production discipline.
- **Parallel-track conflict surface.** `feat/pebble-1.0-search` doesn't exist locally, so no current conflict. If/when it appears, the search track touches `pebble/orchestrator/builtin_tools.py:search_crm` only; Chisel migrates that tool, so a 3-way merge applies.

---

## §7 — Verification log

Claims in this doc that bear on architecture, with the line that proves them:

| Claim | Citation | Verified? |
|---|---|---|
| ToolSpec is a frozen dataclass with handler must-be-async | `pebble/orchestrator/tools.py:58-66, 100-106` | ✓ |
| Registry has unregister but no DX wraps it | `pebble/orchestrator/tools.py:109-111` | ✓ |
| `to_anthropic_dict` exposes name + description + input_schema only (no tags) | `pebble/orchestrator/tools.py:68-74` | ✓ |
| Side-effect imports in streaming.py are mandatory and silent-fail | `pebble/handlers/streaming.py:62-68` + comment | ✓ |
| `ToolSpec.tags` is set in at least one place but never surfaced | `pebble/workflows/weekly_pipeline_review.py:462` (`tags=("workflow","pipeline")`) + grep through planner shows no consumer | ✓ |
| Renderer has a generic fallback (not silent failure) | `pebble/orchestrator/renderer.py:222-235, 320-327` | ✓ |
| Workflow has 4 stitching points | `router.py:91-97` + `streaming.py:250-261` + `workflows/__init__.py:24-32` + `workflows/weekly_pipeline_review.py:433-518` | ✓ |
| Workflow short-circuit uses `allow_replan=False` | `pebble/handlers/streaming.py:237-238`, `pebble/orchestrator/chat_orchestrator.py:302` | ✓ |
| Phase-0 contract: "no core changes" needed for new tools/workflows | `pebble/orchestrator/tools.py:20-21`, `pebble/workflows/__init__.py:19-21` | ✓ |
| Reserved-but-unbuilt workflows | `pebble/router.py:93-96` | ✓ |
| Sprint 12 will add RBAC + per-user cost caps | `tasks/sprint12-pebble-access-control.md` (read by research subagent) | reported, not re-verified |
| Sprint 11 will add scratchpad persistence (worsens F9) | `tasks/sprint11-pebble-persistence-crm.md` (read by research subagent) | reported, not re-verified |
| Anthropic Skills open spec, MCP 2025-11-25 spec | `agentskills.io/specification`, `modelcontextprotocol.io/specification/2025-11-25/server/tools` | web-fetched 2026-05-11 |
