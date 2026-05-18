-- 2026-05-18: pebble_network_edges + pebble_giving_history
--
-- Wave 0 of the Pebble L2 Research Swarm plan
-- (~/.claude/plans/glistening-crafting-matsumoto.md §5.1, §5.2, §5.4).
--
-- Why:
--     HNW research without a relationship graph is flat text. A
--     prospect's value to a fundraising team comes from their
--     network: who they sit on boards with, who they give
--     alongside, who their advisors are, what foundations they
--     control. Today's Pebble emits a flat list of Claim objects
--     (pebble.schemas.profile.Profile.claims) with no edges.
--
--     Cluster D (Network Mapping, §5.1) emits four edge types via
--     four parallel doers:
--         D1 co_board       — 990 officer overlap across orgs
--         D2 co_donor       — FEC committee co-appearance
--         D3 family_candidate — surname + city heuristic (low conf)
--         D4 professional_peer — LDA co-registrant
--     Plus future advisor / spouse / co_trustee edge types as data
--     sources expand.
--
--     pebble_network_edges stores one row per detected edge with
--     a verifier verdict, strength score, and evidence URL. The
--     peer_person_normalized column ("lastname|firstinitial|state")
--     lets a future cross-prospect graph (Wave 8, post-1.0)
--     compose edges into a property graph queryable by
--     "show me everyone Pursuit has researched who shares a
--     board seat with X" — without backfill.
--
--     Cluster E (Giving Trends, §5.2) emits one row per (prospect,
--     giving_kind, year_or_cycle) tuple capturing multi-year
--     philanthropic / political / federal-received totals. Today
--     ProPublica's filings_with_data array is fetched but only
--     the latest tax year is parsed; the historical pattern
--     (5-year escalation? plateau? decline?) is a meaningful
--     capacity + propensity signal.
--
--     direct_grant_into_foundation is the giving_kind for §5.6:
--     when a prospect controls foundation X and X's Schedule B
--     lists other foundations giving INTO it, those flows are
--     recorded here so the synthesis stage can surface "Y
--     Foundation has given $200K/yr to Z Foundation since 2019"
--     as an affinity signal.
--
-- Related:
--     * ~/.claude/plans/glistening-crafting-matsumoto.md §5.1-5.6
--     * pebble/clusters/org_intelligence.py:118-235 (990 XML
--       officer parsing, reused by Cluster D1)
--     * pebble/data_sources/propublica.py:76-91 (filings_with_data,
--       reused by Cluster E1 multi-year extraction)
--     * pebble/data_sources/fec.py (Cluster D2 co-donor)
--     * pebble/data_sources/lda.py (Cluster D4 professional peers)
--
-- Idempotent — safe to re-run.
--
-- Apply as bedrock owner:
--     psql "$DATABASE_URL" -f 2026-05-18-pebble-network-and-giving.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- pebble_network_edges — Cluster D output
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.pebble_network_edges (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    session_id               UUID NOT NULL,
    prospect_id              TEXT NOT NULL,

    edge_type                TEXT NOT NULL CHECK (edge_type IN (
        'co_board',
        'co_donor',
        'family_candidate',
        'professional_peer',
        'advisor',
        'spouse',
        'co_trustee'
    )),

    -- Peer subject. At least one of peer_person_name or
    -- peer_org_name must be non-null (enforced by application
    -- code; could add CHECK constraint when subject types
    -- stabilize across edge types).
    peer_person_name         TEXT,

    -- Normalized form for cross-prospect dedup + future graph.
    -- Format: "lastname|firstinitial|state" (lowercase, ASCII-
    -- folded). NULL when edge subject is an organization.
    peer_person_normalized   TEXT,

    peer_org_name            TEXT,
    peer_org_ein             TEXT,

    -- Bridge context: the org or committee that connects the
    -- prospect to the peer.
    via_org_name             TEXT,
    via_org_ein              TEXT,
    via_committee_id         TEXT,
    via_client               TEXT,             -- LDA client_id for D4

    -- Temporal anchor. For co_board: tax year of 990 filing.
    -- For co_donor: FEC cycle ("2024" or "2023-2024"). For
    -- family_candidate: not applicable (NULL).
    year_or_cycle            TEXT,

    -- Strength: implementation-defined per edge type.
    --   co_board:     log(1 + count_of_shared_orgs)
    --   co_donor:     log(1 + shared_committee_count)
    --                  * log(1 + joint_amount_bucket)
    --   family_candidate: surname_rarity_score * shared_org_count
    --   professional_peer: shared_filing_count
    strength_score           NUMERIC,

    -- Verifier verdict — see §10 Decision 4 for default confidence
    -- by edge type.
    confidence               TEXT NOT NULL
        CHECK (confidence IN ('high','medium','low')),

    -- Mandatory citation; required for cockpit + audit trail.
    evidence_url             TEXT NOT NULL,
    evidence_excerpt         TEXT,

    -- Verifier loop outcome at admission.
    verified                 BOOLEAN NOT NULL DEFAULT FALSE,
    verifier_note            TEXT,         -- e.g. "parse_failed" → low confidence

    -- Origin attribution. Examples: "cluster_d.doer_d1",
    -- "cluster_d.doer_d2".
    discovered_by            TEXT,

    -- Audit attribution.
    originating_user_email   TEXT,

    -- Multi-tenant outer guard.
    org_id                   TEXT NOT NULL DEFAULT 'pursuit'
);

-- Per-prospect edge browse + cockpit "Final profile" render.
CREATE INDEX IF NOT EXISTS idx_pebble_edges_prospect_type
    ON bedrock.pebble_network_edges(prospect_id, edge_type);

-- Per-session: load all edges produced by one run.
CREATE INDEX IF NOT EXISTS idx_pebble_edges_session
    ON bedrock.pebble_network_edges(session_id);

-- Cross-prospect graph: "who else have we researched that
-- shares this peer?"
CREATE INDEX IF NOT EXISTS idx_pebble_edges_peer_norm
    ON bedrock.pebble_network_edges(peer_person_normalized)
    WHERE peer_person_normalized IS NOT NULL;

-- "What org bridges the most prospects?" — promotes a foundation
-- to "key network org" when it surfaces in 3+ co_board edges.
CREATE INDEX IF NOT EXISTS idx_pebble_edges_via_org
    ON bedrock.pebble_network_edges(via_org_ein)
    WHERE via_org_ein IS NOT NULL;

-- Confidence filtering for cockpit ("show me only high-conf edges").
CREATE INDEX IF NOT EXISTS idx_pebble_edges_confidence
    ON bedrock.pebble_network_edges(prospect_id, confidence);

COMMENT ON TABLE bedrock.pebble_network_edges IS
    'Cluster D output: structured relationship edges between a prospect and other persons or organizations. One row per detected edge. peer_person_normalized enables a future cross-prospect graph query without backfill.';
COMMENT ON COLUMN bedrock.pebble_network_edges.peer_person_normalized IS
    'Format "lastname|firstinitial|state" — lowercase, ASCII-folded. NULL when subject is an organization. The dedup + future-graph join key.';
COMMENT ON COLUMN bedrock.pebble_network_edges.confidence IS
    'Verifier verdict. Defaults by edge type (Decision 4): co_board=high (when explicit title+recent year), co_donor=medium, family_candidate=low, professional_peer=medium. Verifier can promote/demote.';
COMMENT ON COLUMN bedrock.pebble_network_edges.strength_score IS
    'Per-edge-type formula (Plan §5.1). Bigger = stronger evidence. NOT a confidence — confidence is a discrete label, strength is continuous.';

-- ---------------------------------------------------------------------------
-- pebble_giving_history — Cluster E output
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bedrock.pebble_giving_history (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    session_id               UUID NOT NULL,
    prospect_id              TEXT NOT NULL,

    giving_kind              TEXT NOT NULL CHECK (giving_kind IN (
        'philanthropic',                    -- E1: foundations controlled
        'political',                        -- E2: FEC contributions
        'federal_recipient',                -- E3: USAspending awards
        'direct_grant_into_foundation'      -- §5.6: Schedule B of recipient orgs
    )),

    -- Calendar year ("2024") for philanthropic/federal_recipient;
    -- FEC cycle ("2023-2024") for political; flexible.
    year_or_cycle            TEXT NOT NULL,

    total_usd                NUMERIC,

    -- Per-record sub-data:
    --   philanthropic: [{recipient_name, recipient_ein, amount,
    --                    purpose}]
    --   political: [{committee_id, committee_name, amount, party}]
    --   federal_recipient: [{award_id, agency, amount, period}]
    --   direct_grant_into_foundation: [{donor_org_name, donor_ein,
    --                                   amount, year}]
    top_recipients_json      JSONB,

    -- Which foundation channeled this giving (for philanthropic).
    -- Lets the cockpit show "Maria's giving via Y Foundation was
    -- $X in 2024".
    via_org_ein              TEXT,
    via_org_name             TEXT,

    evidence_url             TEXT NOT NULL,
    evidence_excerpt         TEXT,

    -- Trend bucket — populated by E1/E2 when ≥3 data points
    -- exist. NULL otherwise.
    trend_direction          TEXT CHECK (trend_direction IN (
        'increasing','flat','declining', NULL
    )),
    trend_year_span          SMALLINT,    -- # of years in trend

    -- Ideology cluster (E2 political only).
    ideology_cluster         TEXT CHECK (ideology_cluster IN (
        'liberal','conservative','mixed','unknown', NULL
    )),

    discovered_by            TEXT,        -- "cluster_e.doer_e1" etc.
    originating_user_email   TEXT,
    org_id                   TEXT NOT NULL DEFAULT 'pursuit'
);

-- Hot path: per-prospect timeline.
CREATE INDEX IF NOT EXISTS idx_pebble_giving_prospect
    ON bedrock.pebble_giving_history(prospect_id, giving_kind, year_or_cycle);

-- Per-session rollup.
CREATE INDEX IF NOT EXISTS idx_pebble_giving_session
    ON bedrock.pebble_giving_history(session_id);

-- "What years was a foundation active?" — drives the Capacity
-- Estimator's foundation-throughput proxy.
CREATE INDEX IF NOT EXISTS idx_pebble_giving_via_org
    ON bedrock.pebble_giving_history(via_org_ein, year_or_cycle)
    WHERE via_org_ein IS NOT NULL;

COMMENT ON TABLE bedrock.pebble_giving_history IS
    'Cluster E output: multi-year giving timeline. One row per (prospect, giving_kind, year_or_cycle). Drives the cockpit timeline view + the Capacity Estimator (§5.5).';
COMMENT ON COLUMN bedrock.pebble_giving_history.giving_kind IS
    'philanthropic = foundation-controlled giving from 990s; political = FEC contributions; federal_recipient = USAspending awards received; direct_grant_into_foundation = Schedule B inbound to a foundation the prospect controls.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT, UPDATE ON bedrock.pebble_network_edges TO bedrock_user;
        GRANT SELECT, INSERT, UPDATE ON bedrock.pebble_giving_history TO bedrock_user;
        -- UPDATE allowed because verifier verdicts can promote / demote
        -- confidence and discovered_by post-insert during the loop.
    END IF;
END $$;
