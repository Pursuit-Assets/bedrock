# Pebble Rollup — Review Package for Jac

**Branch:** `feat/pebble-rollup` (local-only, not pushed)
**Worktree:** `~/Desktop/pursuit-financial-forecasting-chisel`
**Tip:** `63133a6` (Merge origin/dev into feat/pebble-rollup)
**Status:** 102 commits ahead of `origin/dev`, 158 files, +29,977 / −1,236, **796 tests passing**

---

## What's in the rollup

Five workstreams consolidated into one branch:

| # | Theme | Commits | What it ships |
|---|-------|---------|---------------|
| 1 | **Chisel A/B/C** — Pebble's tool/workflow authoring framework | ~12 | Hybrid manifest+module loader, autoload registry, Phase B canonical-query eval harness, Phase C manifest-save endpoints + frontend browser/drawer |
| 2 | **F1–F19** — Research fidelity invariants | ~25 | Quorum fail-closed, claim dedup, URL verification, name-match, citation contracts, conflict detection, deterministic confidence rubric, claim-pool fingerprint, freshness ranking, source tiers, per-claim agent attribution, anti-paraphrase, proper-noun grounding |
| 3 | **P1–P4** — Pipeline perf | ~8 | Native async httpx for FEC/SEC/ProPublica/USAspending/Wikipedia/OpenCorporates/EDGAR; parallel save_profile + save_session; background source_scores; shared client + retry helper |
| 4 | **Pebble orchestrator polish** | ~17 | LLM client refactor, stage cleanup, audit middleware, search/proxy improvements |
| 5 | **Phase C frontend** | ~5 | `/chisel` route, TanStack Query hooks, manifest browser + detail drawer, nav entry |

`PIPELINE_VERSION = "fidelity-v1.20"` stamped on every saved profile.

## How to review

```bash
cd ~/Desktop/pursuit-financial-forecasting-chisel

# What changed vs the dev tip
git log --oneline origin/dev..HEAD
git diff origin/dev HEAD --stat

# Run the test suite
cd pebble && python3 -m pytest tests/ -q
# → 796 passed

# Spin up the API + frontend (uses dev's deploy scripts, untouched)
# See financial_forecasting/DEV_SETUP_GUIDE.md
```

The 5 merge conflicts with `origin/dev` were all additive — both sides kept (Pebble/Chisel nav + dev's Awards/Jobs nav, Pebble/Chisel routers + dev's affiliations/airtable/sputnik routers, etc.). No dev work was discarded.

---

## What remains to be built — triaged

### CRITICAL (block PR merge or first user)

1. **End-to-end fidelity proof against live APIs.** The 796 tests are unit + mocked-integration. Before any user trusts the "100% accuracy" claim, we need a recorded run of the pipeline against a known prospect (e.g. one of Jac's actual targets) with all F-series invariants observed in real data, not mocks.
2. **`.env.production` value.** Currently `VITE_API_URL=` is empty (inherited from dev). Frontend deploy will 404 on every API call. Needs the actual prod URL filled in.
3. **Bedrock ↔ Pebble JWT pass-through verified end-to-end.** `chisel_proxy.py` forwards `Authorization: Bearer` headers but the cross-service flow has only been tested with unit mocks. Smoke-test against a real running pebble service before shipping.
4. **DB migrations for Chisel manifest persistence.** Phase C.3 save endpoints currently write to the filesystem. If we want multi-replica deploys (Cloud Run scales horizontally), manifests must live in Postgres. Schema design pending.

### NICE-TO-HAVE (improvements, not blockers)

1. **P1.3b** — finish the async conversion: `finra.py`, `lda.py`, `federal_register.py`. Reverted mid-session because the test refactor (sync → `@pytest.mark.asyncio + AsyncMock`) was too invasive for the time we had. Estimated ~20% additional pipeline latency win.
2. **Phase C React editor view.** Today's `/chisel` page is read-only (browser + detail drawer). A textarea + live-validate + save flow against the C.3 PUT endpoints would let non-engineers author tools without `git`.
3. **`.github/workflows/eval-gate.yml`** — wire the Phase B canonical-query eval into CI so manifest regressions block PRs.
4. **Forager retry-with-backoff.** Currently single-shot; transient API failures cause confidence downgrades that would've recovered with one retry.
5. **Operator UI for `research_quality_report`.** The aggregator exists (orchestrator/_pipeline.py); needs a `/chisel/quality` page surfacing fidelity stats over time.
6. **Source-tier customization per org.** The 0/1/2/3 rubric is hardcoded (.gov→0, ProPublica→1, Wikipedia→2, web→3). Orgs that work in niches (e.g. healthcare, academia) should be able to override.

### SUPERFLUOUS (don't build unless explicitly requested)

1. Multi-node Worker swarm distribution — single-process is fine for current scale (~100 prospects/day).
2. Real-time SSE for arbitrary Chisel workflows — only Pebble research needs progress streaming; other tools can be request/response.
3. Multi-tenant Chisel manifest namespacing — Pursuit is single-tenant; YAGNI.
4. Prompt-variant A/B testing harness — fidelity invariants catch the regressions that matter; A/B adds complexity without payoff at this scale.

---

## Deferred / parked decisions for Jac

1. **Push timing.** Branch is local-only per JP's "don't push it yet." Push after Jac's review or after the four CRITICAL items are addressed?
2. **PR target.** Merge into `dev` or directly into `main`? Dev is the natural target; main has been the prod branch in the past.
3. **Chisel manifest storage.** Filesystem (current, simple) vs Postgres (required for horizontal scale). Decide before any multi-replica deploy.
4. **Live-API fidelity demo.** Pick a prospect to run the full pipeline against, recorded, as the credibility artifact for new users.
