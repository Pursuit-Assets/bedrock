# Pebble — Prospect Research Pipeline

Pebble powers prospect research for Bedrock. Integration #9.

## Quick Start

```bash
# From repo root
pip install -r pebble/requirements.txt
cp pebble/.env.example pebble/.env
# Edit pebble/.env: set ANTHROPIC_API_KEY
uvicorn pebble.main:app --reload --port 8001
```

Bedrock (financial_forecasting) runs on 8000. Set `REACT_APP_PEBBLE_API_URL=http://localhost:8001` in the frontend .env to call Pebble.

## Testing Pebble in Bedrock

1. **Start Pebble** (terminal 1):
   ```bash
   uvicorn pebble.main:app --reload --port 8001
   ```

2. **Configure Bedrock frontend** — create or edit `financial_forecasting/frontend/.env.local`:
   ```
   REACT_APP_PEBBLE_API_URL=http://localhost:8001
   ```

3. **Start Bedrock** (terminal 2):
   ```bash
   cd financial_forecasting && python main.py
   # Or: cd financial_forecasting/frontend && npm start
   ```

4. **Open** `http://localhost:3000/pebble` (or your Bedrock URL + `/pebble`).

5. **Test**: Enter First Name, Last Name, Organization (e.g. "Goldman Sachs"), click "Request Research". With `ANTHROPIC_API_KEY` set, Pebble will enrich and return a profile.

## API

- `POST /api/v1/research/request` — Submit contact IDs for research
- `GET /api/v1/research/profiles/{contact_id}` — Get research profile
- `POST /api/v1/research/feedback` — Submit claim feedback (claim_id, correct)

## Env Vars

Copy `pebble/.env.example` to `pebble/.env` and fill in values.

| Var | Required | Description |
|-----|----------|-------------|
| ANTHROPIC_API_KEY | Yes | Anthropic API key |
| OPENROUTER_API_KEY | No | Free worker-tier models (falls back to Anthropic Haiku) |
| FEC_API_KEY | No | FEC API key (use DEMO_KEY for testing) |
| OPENCORPORATES_API_KEY | No | Officer search (free tier: 500 req/month) |
| GOOGLE_CSE_API_KEY | No | Google Custom Search API key — see setup note below |
| GOOGLE_CSE_CX | No | Programmable Search Engine ID — see setup note below |
| SERPER_API_KEY | No | Serper.dev unrestricted web search (free tier: 2,500 queries/month) |
| PEBBLE_API_KEY | No | If set, Bedrock must send X-Api-Key header |

### Web search setup (TODO — team admin)

Pebble uses two web search backends. Both are optional but at least one should be configured for web search to return results.

1. **Google Custom Search (curated domains)** — Requires a Google Cloud project with the Custom Search API enabled, plus a Programmable Search Engine configured with curated domains. Create an API key in Cloud Console > APIs & Services > Credentials, and get the CX from [Programmable Search Engine](https://programmablesearchengine.google.com/). Set `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_CX`.

2. **Serper.dev (unrestricted)** — Sign up at [serper.dev](https://serper.dev), copy the API key from the dashboard. Set `SERPER_API_KEY`. Free tier: 2,500 queries/month.

## Architecture

- **Bee hierarchy:** Worker → Haiku (MVP), Drone → Haiku, Forager → Sonnet, Queen → Opus
- **WorkerHarness:** Timeout, retries, schema validation, cost cap
- **ProspectBudgetTracker:** $0.50/prospect cap

## Authoring tools and workflows (Chisel)

Pebble's chat orchestrator picks its tools and workflows from the **Chisel** registry under `pebble/chisel/`. Each unit is a directory: a declarative `manifest.yaml` plus a Python `handler.py` (Pydantic `Input` model + `async def run(args, ctx)`). At process start, `pebble.chisel.autoload()` walks `pebble/chisel/{tools,workflows}/`, validates each manifest, derives a strict JSON Schema (with `additionalProperties: false`) from the Pydantic model, wraps the handler in a `ToolResult`-constructing adapter, and registers the spec on the shared `DEFAULT_REGISTRY` — no per-tool wiring in the orchestrator.

### Add a new tool

```bash
python -m pebble.chisel.cli scaffold my_new_tool
```

This writes `pebble/chisel/tools/my_new_tool/{manifest.yaml, handler.py, handler_test.py}`. Edit the Pydantic `Input` model + `async def run` and the planner sees the new tool on next request.

### Add a new workflow

Create `pebble/chisel/workflows/<name>/workflow.yaml`:

```yaml
name: my_workflow
description: What it does.
slash_command: /myworkflow                # optional
dispatch_intent: workflow_my_workflow      # planner intent
has_custom_plan: true                      # if you need Python; otherwise declare steps[]
```

For `has_custom_plan: true`, drop `build_plan.py` alongside `workflow.yaml` exposing `def build_plan(*, user_query, **kwargs) -> Plan`. For the declarative form, list `steps[]` instead — Chisel synthesizes the Plan from them.

### Guarantees from the framework

- **Strict schemas** — Pydantic models are post-processed so every object node has `additionalProperties: false` (the planner cannot smuggle unknown args).
- **No handler boilerplate** — the adapter parses dict → Pydantic, times the call, catches exceptions, records `tool_version` from the manifest, and emits a `ToolResult`. Handlers return a plain `dict`.
- **Isolation-safe loading** — `autoload(registry=fresh_registry)` is the test pattern; the production path uses `DEFAULT_REGISTRY`.
- **Snapshot-per-request** — `pebble.chisel.snapshot(registry)` returns an immutable view the executor can thread through one request so an in-flight reload doesn't change behaviour mid-flight.

See `tasks/pebble-chisel-plan.md` for the full Phase A / B / C design.

## Day 5 Verification

Run 5–10 contacts end-to-end to confirm profiles, costs, and harness_log:

1. Start Pebble and Bedrock (see Testing above).
2. Test contacts with org names (e.g. "American Red Cross", "Goldman Sachs") — ProPublica lookup works without EIN.
3. Inspect `pebble/pebble.db`:
   ```bash
   sqlite3 pebble/pebble.db "SELECT agent_name, outcome, cost_usd, prospect_id FROM harness_log ORDER BY created_at DESC LIMIT 20;"
   ```
4. Confirm cost per prospect < $0.50 and profiles have claims with `source_url`.
