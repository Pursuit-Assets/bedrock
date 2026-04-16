# Sprint 3.5 Build Prompt — CRM Tool-Use Agent for L0/L1

Paste everything below the line into a new Claude Code session.

---

```
Build Ask Pebble Sprint 3.5 — a single Haiku tool-use agent that replaces the hardcoded L0/L1 handlers with a flexible CRM agent.

## What's already built (PRs #50–#52, all merged)

- **Ask Pebble core**: Tiered query routing (L0/L1/T1/T2/T3), chat UI, CRM bridge, readiness module
- **Sprint 3 cluster architecture**: Prospect type routing, 3 concurrent research clusters, 13 source groups with per-type activation matrices
- **L0 handler** (`pebble/handlers/level0.py`): Hardcoded intent handlers for `contact_field_lookup`, `pipeline_query`, `entity_list`
- **L1 handler** (`pebble/handlers/level1.py`): Same intents + single Haiku synthesis call
- **CRM bridge** (`pebble/crm_bridge.py`): Wraps Bedrock's Salesforce API — search_all, search_contacts, search_accounts, search_opportunities, get_opportunities
- **Router** (`pebble/router.py`): Haiku classifier that assigns level + intent + entities

## The problem

L0/L1 handlers are rigid intent-specific code paths. "What's the pipeline for Goldman Sachs?" requires chaining contact lookup → account → opportunity filter — the current handlers can't do multi-step lookups. Adding new CRM query patterns means writing new hardcoded handlers every time.

## The design (approved by JP)

Replace L0 and L1 with a **single Haiku tool-use agent** that has access to all CRM operations. The agent reasons about which tools to call, handles multi-step lookups naturally, and returns natural language answers.

### Tools the agent gets

```python
# 5 CRM tools wrapping crm_bridge methods
crm_search(query, limit=10)                          → Cross-entity SOSL results
crm_contacts(query, limit=10)                        → Contact SOQL results
crm_accounts(query, limit=10)                        → Account SOQL results
crm_opportunities(query, account_id=None, limit=10)  → Opportunity SOQL results
crm_pipeline(stage=None)                             → All opportunities, optionally filtered by stage
```

### Bounded autonomy
- Max 5 tool calls per query (prevents runaway loops)
- 15-second timeout
- Budget: $0.02 cap per L0/L1 query
- If tool calls fail or agent can't answer, fallback to "I couldn't find that in the CRM"

### How it fits in the tier system
1. Router classifies query as L0 or L1 (unchanged)
2. Dispatcher routes to `handle_crm_agent()` instead of `handle_l0()`/`handle_l1()`
3. Agent receives: user query, any pre-fetched CRM search results from disambiguation, conversation context
4. Agent makes 1-3 tool calls, reasons over results
5. Returns: natural language answer + structured data (for frontend)
6. Old L0/L1 handlers kept as fallback when no LLM client available

### What this enables
- Multi-step lookups: "What's the pipeline for Goldman Sachs?" → search accounts → search opportunities by account_id
- Aggregation: "How many contacts do we have at foundations?" → search accounts by type → count
- Cross-entity: "Who owns the opportunities for [org]?" → search opportunities → extract Owner.Name
- Comparison: "Compare Jane's and Bob's opportunity pipelines" → 2 contact searches → 2 opportunity searches
- Natural language answers instead of formatted tables

## Critical files to read before building

- **The plan**: `/Users/jp/.claude/plans/glimmering-humming-yeti.md` — Part 2 has the full design
- **Current L0 handler**: `pebble/handlers/level0.py` — being replaced
- **Current L1 handler**: `pebble/handlers/level1.py` — being replaced
- **Handler dispatch**: `pebble/handlers/__init__.py` — needs L0/L1 routing change
- **CRM bridge**: `pebble/crm_bridge.py` — the tool implementations wrap these methods
- **Model client**: `pebble/model_client.py` — how LLM calls work, tiers, cost tracking
- **Worker harness**: `pebble/harness.py` — existing bounded-autonomy framework (WorkerHarness, TaskSpec, HarnessConfig, agent templates)
- **Router**: `pebble/router.py` — classifies queries, assigns level + intent + entities
- **Chat schemas**: `pebble/schemas/chat.py` — response format the frontend expects

## Architecture decisions already made

- **Haiku for the CRM agent** (not Sonnet): CRM tools return structured data — reasoning demands are low. $0.005/query vs $0.02. Escalate to Sonnet only if Haiku can't handle multi-step queries.
- **Tool-use, not function calling**: The agent decides which tools to call based on the query. This is Claude's native tool_use capability.
- **Keep old handlers as fallback**: If no LLM client is available (dev mode, API outage), fall back to the hardcoded L0/L1 handlers.
- **Budget: $0.02 cap per query**: Generous for Haiku tool-use. Most queries will cost $0.003-0.008.
- **Conversation context**: Pass recent conversation history to the agent so it can resolve "her" → "Jane Smith" from prior turns.

## Implementation approach

### New files
1. `pebble/tools/crm_tools.py` — Tool definitions (name, description, input_schema) wrapping crm_bridge
2. `pebble/tools/__init__.py` — Package init
3. `pebble/handlers/crm_agent.py` — The tool-use agent handler: builds messages, runs tool loop, formats response

### Modified files
4. `pebble/handlers/__init__.py` — Route L0/L1 to crm_agent (with fallback to old handlers)
5. `pebble/model_client.py` — Add tool-use support to ModelClient (if not already present)

### Tool-use loop pattern
```python
async def handle_crm_agent(route, crm_bridge, search_results, client):
    # 1. Build initial messages with system prompt + user query + search context
    # 2. Loop (max 5 iterations):
    #    a. Call Haiku with tools
    #    b. If response has tool_use blocks → execute tools → append results
    #    c. If response has text (no more tool calls) → break
    # 3. Format response as HandlerResponse
```

### System prompt for the CRM agent
The agent needs to know:
- It's a CRM assistant for a nonprofit fundraising team
- Available tools and when to use each
- Response format: concise, factual, cite specific records
- Don't make up data — if not found, say so
- For ambiguous names, ask for clarification (return requires_clarification)

## Important preferences

- Build production-ready — no stubs or placeholders
- Haiku first, Sonnet escalation path for later
- Keep it simple — the tool-use loop is the core, everything else is plumbing
- Test with real-ish queries: "What's Jane Smith's title?", "Show me the pipeline", "How many opportunities over $50k?"
```

---

## Starting the servers

```bash
# Terminal 1: Bedrock (port 8000) — must run from financial_forecasting/ dir for .env loading
cd financial_forecasting && python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: Pebble (port 8001) — run from project root
cd /Users/jp/Desktop/pursuit-financial-forecasting && python3 -m uvicorn pebble.main:app --host 0.0.0.0 --port 8001 --reload

# Terminal 3: Frontend (port 3000) — auto-reloads
cd financial_forecasting/frontend && npm start
```
