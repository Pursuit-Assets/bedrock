# Sprint 4+ Planning Prompt — Post-3.5 Rescoping

Paste everything below the line into a new Claude Code session.

---

```
You are planning the next sprints for Ask Pebble after Sprint 3.5 shipped. Enter plan mode immediately — this is a planning session, not a build session.

## What's already built (PRs #50–#53, all merged to main)

### Sprint 1–2 (PR #50–#51): Research Foundation
- Tiered query routing: T0/T0.5 (CRM queries), T1 (triage), T2 (structured), T3 (full research)
- Chat UI with tier badges, clarification flows, conversation history
- CRM bridge wrapping Bedrock's Salesforce API (search_all, search_contacts, search_accounts, search_opportunities, get_opportunities)
- 5 new data sources: LDA lobbyist disclosures, FINRA BrokerCheck, FEC extended (committees + independent expenditures), EDGAR Form 4 insider transactions, Federal Register
- Temporal accuracy (claim age tracking, recency scoring)
- Readiness module with disambiguation (CLARIFY, CROSS_ENTITY, IDENTITY_RISK, NEW_ENTITY)

### Sprint 3 (PR #52): Cluster Architecture
- 3 concurrent research clusters: Financial, Affiliation, Public Profile
- Prospect type routing (INDIVIDUAL, FOUNDATION, CORPORATE, GOVERNMENT, UNKNOWN)
- Per-type activation matrices (each cluster only fetches sources relevant to prospect type)
- Source richness scoring → selective forager activation
- ProspectResearchContext for cross-tier data accumulation

### Sprint 3.5 (PR #53): CRM Tool-Use Agent ← JUST SHIPPED
- **Single Haiku tool-use agent** replaces hardcoded T0/T0.5 handlers
- 5 CRM tools: crm_search, crm_contacts, crm_accounts, crm_opportunities, crm_pipeline
- `complete_with_tools()` method on ModelClient (Anthropic direct, tool-use API)
- Bounded autonomy: max 5 API rounds, 15s timeout, $0.02 cost cap
- Conversation context (last 3 turns) passed for multi-turn reasoning
- Old L0/L1 handlers kept as fallback when no LLM client
- L0/L1 renamed to T0/T0.5 across backend + frontend
- Bug fix: _complete_anthropic() return key mismatch

## The problem — Sprint 4 needs rescoping

The original Sprint 4 plan (in `/Users/jp/.claude/plans/floating-wobbling-sedgewick.md`, lines 385–534) was written BEFORE Sprint 3.5's tool-use agent existed. It bundles 6 sub-features into one sprint:

1. Org Intelligence module (investigate orgs connected to prospects)
2. ProPublica Form 990 XML officer extraction (T3 only)
3. Research recommendation schema (create_account, create_contact triggers)
4. CRM Write Bridge (create_account, create_contact methods + Bedrock endpoints)
5. CRM Write Permissions (3-tier: create, modify_related, modify_all)
6. Human Review Gate in Chat UI (recommendation cards with approval flow)

### Why it needs rescoping:

**Architecture mismatch:** The original plan adds CRM writes as separate REST endpoints with a standalone approval flow. But Sprint 3.5 established tool-use as the CRM interaction pattern. CRM writes should be tools the agent can invoke — with human-in-the-loop confirmation — not a parallel system.

**Scope too large:** This is 3 sprints of work, not 1. Org Intelligence + XML parsing is pure backend. CRM writes + permissions is a separate feature. The approval UI is frontend-heavy and depends on both.

**Sprint 3.5 creates new possibilities:** The tool-use agent + conversation context means the approval flow can be conversational ("I found Robin Hood Foundation. Want me to save it to Salesforce?") rather than a rigid recommendation card UI.

## Your task

1. **Read the critical files** to understand current architecture:
   - The original Sprint 4 plan: `/Users/jp/.claude/plans/floating-wobbling-sedgewick.md` (lines 385–534)
   - The strategic rationale: `/Users/jp/.claude/plans/glimmering-humming-yeti.md` (Part 3)
   - The Sprint 3.5 CRM agent: `pebble/handlers/crm_agent.py`
   - The tool definitions: `pebble/tools/crm_tools.py`
   - The tool-use method: `pebble/model_client.py` (complete_with_tools)
   - Cluster architecture: `pebble/clusters/` directory
   - Existing ProPublica source: `pebble/data_sources/propublica.py`
   - T2 handler (cluster orchestration): `pebble/handlers/tier2.py`
   - T3 handler (quorum + synthesis): `pebble/handlers/tier3.py`
   - CRM bridge: `pebble/crm_bridge.py`
   - Bedrock Salesforce routes: `financial_forecasting/routes/salesforce_search.py`
   - Existing Salesforce service: `mcp_client/services/salesforce.py` (has create_account/create_contact at lines 206–230)

2. **Propose a sprint breakdown** that:
   - Splits the 6 features into 2–3 focused sprints
   - Puts pure backend (org intelligence, XML) first since it's unaffected by 3.5
   - Designs CRM writes as agent tools (not separate endpoints) leveraging the tool-use pattern from 3.5
   - Keeps each sprint shippable and testable independently
   - Considers that this rolls out to a small team soon — prioritize what they'll use first

3. **For each proposed sprint, define:**
   - What it builds (specific files, methods)
   - What it depends on
   - What it enables for the next sprint
   - How to verify it works

4. **Flag design decisions** that need JP's input:
   - Should CRM writes be tools on the existing T0/T0.5 agent, or a separate elevated agent?
   - Should the approval flow be conversational (agent asks, user confirms) or card-based (rendered recommendations)?
   - Should org intelligence run automatically after T2/T3, or be user-triggered ("investigate connected orgs")?
   - How should the 990 XML rate limit (1/min) be handled in the UX?

## Important constraints
- **No demo versions.** Build production-ready from the start.
- **Simplicity first.** Don't over-engineer — the tool-use pattern from 3.5 is the right model.
- **Target stack compatibility.** This integrates into React 19 + Vite + Tailwind + shadcn/ui | Node.js + Express | PostgreSQL + pgvector (see CLAUDE.md for details).
- **Budget awareness.** Haiku for tool-use ($0.003–0.008/query). Sonnet for synthesis. Opus only for T3 final profile.
- **Existing code reuse.** Salesforce create methods already exist in mcp_client/services/salesforce.py. ProPublica API is in pebble/data_sources/propublica.py. Don't rebuild what's there.

## Output

Write the rescoped sprint plan to `tasks/sprint4-rescoped-plan.md` with:
- Sprint breakdown table
- Per-sprint scope, files, and verification
- Design decision questions for JP
- Build prompts for each sprint (ready to paste into new sessions)
```

---

## Starting the servers (for reference)

```bash
# Terminal 1: Bedrock (port 8000)
cd financial_forecasting && python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: Pebble (port 8001)
cd /Users/jp/Desktop/pursuit-financial-forecasting && python3 -m uvicorn pebble.main:app --host 0.0.0.0 --port 8001 --reload

# Terminal 3: Frontend (port 3000)
cd financial_forecasting/frontend && npm start
```
