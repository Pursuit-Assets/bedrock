-- 2026-05-06: bedrock.search_doc + bedrock.search_index_queue
--
-- Layer 1 of the Pebble 1.0 search system. The denormalized,
-- cross-entity search index that GlobalSearch Find mode and Pebble's
-- Ask-mode tool calls both query against. Replaces the SOSL passthrough
-- at routes/salesforce_search.py.
--
-- Design — see tasks/pebble-search-spec-backend.md §2 for the full
-- argument. Headlines:
--
--   * One denormalized table, one row per searchable entity. Cross-
--     entity ranking uses a single query plan vs UNION ALL of N
--     per-entity indexes.
--   * tsvector + GIN on the composed search_vector for lexical match.
--   * pg_trgm + GIN on search_text for typo tolerance ("ed millr" →
--     "Ed Miller").
--   * pgvector halfvec(768) embedding column reserved for v1.1
--     semantic-recall overlay; not populated in v1.0.
--   * Permission columns are FK-shaped (owner_sf_id, owner_email,
--     account_sf_id, visibility) so the API layer can compose a
--     pre-filter accessible-id subquery without denormalizing
--     per-user ACL into rows. See backend spec §4 for the rejection
--     of the post-filter and ACL-array alternatives.
--   * Soft-delete via partial index — tombstones in the heap, never
--     in the GIN posting list.
--   * Multi-tenant org_id from day 1, even though Pursuit is single
--     tenant today (security spec §7).
--
-- search_index_queue is the durable backbone of the indexer worker
-- pattern (backend spec §3). Every entity write enqueues a row;
-- LISTEN/NOTIFY wakes the worker; FOR UPDATE SKIP LOCKED lets us
-- shard later without changing the schema.
--
-- Idempotent — safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- search_doc
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.search_doc (
    -- Composite identity. The 11-value CHECK constraint is
    -- intentionally explicit (not ENUM) so adding a new entity_type
    -- is a plain ALTER TABLE rather than the multi-step ALTER TYPE
    -- dance Postgres requires for enum mutation.
    entity_type     TEXT NOT NULL CHECK (entity_type IN (
        'sf_account','sf_contact','sf_opportunity','sf_task','sf_activity',
        'bedrock_project','bedrock_award','bedrock_saved_view',
        'pebble_profile','pebble_chat_conversation','pebble_batch'
    )),
    entity_id       TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id),

    -- Display projection. The frontend renders these directly; no
    -- post-query JOIN to source tables on the read path.
    title           TEXT NOT NULL,
    subtitle        TEXT,
    href            TEXT NOT NULL,

    -- Lexical search.
    search_vector   TSVECTOR NOT NULL,
    search_text     TEXT NOT NULL,

    -- Semantic recall layer. Reserved for v1.1; v1.0 leaves this
    -- column NULL. Defining it now means we don't have to
    -- ALTER TABLE on a 200k-row hot table later.
    embedding       halfvec(768),

    -- Permission columns. Pre-filter via accessible-id subquery
    -- (backend spec §4). owner_sf_id is the SF user id when the
    -- entity is SF-mirrored; owner_email is the Bedrock-side
    -- owner. account_sf_id is the parent account for permission
    -- inheritance (Contact / Opp / Task visible to whoever can
    -- see the parent Account, plus their direct owner).
    owner_sf_id     TEXT,
    owner_email     CITEXT,
    account_sf_id   TEXT,
    visibility      TEXT NOT NULL DEFAULT 'org'
        CHECK (visibility IN ('private','team','org')),

    -- Recency signal. Computed at ranking time as
    -- ts_rank_cd(...) * exp(-EXTRACT(epoch FROM now() - activity_at) / (86400 * 30))
    -- so half-life is tunable without reindexing.
    activity_at     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,

    -- Indexer metadata. source_version is the source row's
    -- version (e.g. SF SystemModstamp or bedrock row's updated_at)
    -- so the indexer can skip re-indexing when the source hasn't
    -- changed since indexed_at.
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_version  TIMESTAMPTZ,

    -- Multi-tenant outer guard.
    org_id          TEXT NOT NULL DEFAULT 'pursuit'
);

-- Lexical search index. Partial on deleted_at IS NULL means
-- soft-deleted tombstones never enter the GIN posting list — they
-- still consume heap, but search ignores them.
CREATE INDEX IF NOT EXISTS idx_search_doc_fts
    ON bedrock.search_doc USING GIN(search_vector)
    WHERE deleted_at IS NULL;

-- Trigram fuzzy match for typo tolerance. Same partial predicate.
CREATE INDEX IF NOT EXISTS idx_search_doc_trgm
    ON bedrock.search_doc USING GIN(search_text gin_trgm_ops)
    WHERE deleted_at IS NULL;

-- Permission filter inputs.
CREATE INDEX IF NOT EXISTS idx_search_doc_owner_sf
    ON bedrock.search_doc(owner_sf_id)
    WHERE deleted_at IS NULL AND owner_sf_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_search_doc_owner_email
    ON bedrock.search_doc(owner_email)
    WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_search_doc_account
    ON bedrock.search_doc(account_sf_id)
    WHERE deleted_at IS NULL AND account_sf_id IS NOT NULL;

-- Multi-tenant guard.
CREATE INDEX IF NOT EXISTS idx_search_doc_org
    ON bedrock.search_doc(org_id)
    WHERE deleted_at IS NULL;

-- Per-entity-type filtering for facets ("show me only Opps").
CREATE INDEX IF NOT EXISTS idx_search_doc_entity
    ON bedrock.search_doc(entity_type)
    WHERE deleted_at IS NULL;

-- Recency tiebreaker / "recent" scope.
CREATE INDEX IF NOT EXISTS idx_search_doc_activity
    ON bedrock.search_doc(activity_at DESC)
    WHERE deleted_at IS NULL AND activity_at IS NOT NULL;

-- pgvector index reserved for v1.1. Created as a no-op now (no
-- rows have embeddings yet) so the schema is fixed-shape before
-- backfill begins.
CREATE INDEX IF NOT EXISTS idx_search_doc_embedding_hnsw
    ON bedrock.search_doc USING hnsw (embedding halfvec_cosine_ops)
    WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- search_vector composer trigger. Single weighting policy so the
-- relevance contract is in one place, not scattered across writers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bedrock.search_doc_compose_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title,    '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.subtitle, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.search_text, '')), 'C');
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_search_doc_compose'
    ) THEN
        CREATE TRIGGER trg_search_doc_compose
            BEFORE INSERT OR UPDATE ON bedrock.search_doc
            FOR EACH ROW EXECUTE FUNCTION bedrock.search_doc_compose_vector();
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- search_index_queue — durable hand-off from source-table writes
-- to the asynchronous indexer worker.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.search_index_queue (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    op              TEXT NOT NULL CHECK (op IN ('upsert','delete')),
    enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempt_count   INT NOT NULL DEFAULT 0,
    last_error      TEXT,

    -- Coalesce: multiple enqueues of the same entity collapse to
    -- one row; ON CONFLICT bumps enqueued_at so the worker
    -- processes them in FIFO order without missing any.
    UNIQUE (entity_type, entity_id, op)
);

-- Drain index. Worker uses
--   SELECT ... FROM bedrock.search_index_queue
--   ORDER BY enqueued_at ASC FOR UPDATE SKIP LOCKED LIMIT 100
-- so this index serves both the order-by and the lock-skip.
CREATE INDEX IF NOT EXISTS idx_search_queue_drain
    ON bedrock.search_index_queue(enqueued_at);

-- Failed-row index. Periodic reconciliation reads attempt_count > 0
-- to surface stuck rows.
CREATE INDEX IF NOT EXISTS idx_search_queue_stuck
    ON bedrock.search_index_queue(attempt_count, enqueued_at)
    WHERE attempt_count > 0;

-- ---------------------------------------------------------------------------
-- Generic enqueue trigger. Source-table triggers reference this
-- with a TG_ARGV[0] entity_type tag. Bedrock-native source tables
-- get one CREATE TRIGGER apiece in subsequent migrations.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bedrock.enqueue_search_index() RETURNS trigger AS $$
DECLARE
    et TEXT := TG_ARGV[0];
    eid TEXT;
    op_val TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        eid := OLD.id::TEXT;
        op_val := 'delete';
    ELSE
        eid := NEW.id::TEXT;
        op_val := 'upsert';
    END IF;

    INSERT INTO bedrock.search_index_queue (entity_type, entity_id, op)
    VALUES (et, eid, op_val)
    ON CONFLICT (entity_type, entity_id, op) DO UPDATE
        SET enqueued_at = now(), attempt_count = 0, last_error = NULL;

    -- LISTEN/NOTIFY wakes the worker; payload includes the key so a
    -- cleverer worker could skip the SELECT for the hot path.
    PERFORM pg_notify('bedrock_search_index_queue', et || ':' || eid);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- updated_at trigger reuses the existing helper.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_search_doc_updated_at'
    ) THEN
        CREATE TRIGGER trg_search_doc_updated_at
            BEFORE UPDATE ON bedrock.search_doc
            FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
    END IF;
END $$;

COMMENT ON TABLE bedrock.search_doc IS
    'Denormalized cross-entity search index (Phase 1.1). One row per searchable entity; populated by the queue-drain indexer worker. Permission filtering is pre-filter via accessible-id subquery.';
COMMENT ON COLUMN bedrock.search_doc.embedding IS
    'pgvector halfvec(768) for v1.1 semantic-recall overlay. NULL in v1.0 — schema reserved so backfill never has to ALTER.';
COMMENT ON TABLE bedrock.search_index_queue IS
    'Durable queue from source-table writes to the indexer worker. ON CONFLICT coalesces duplicates; LISTEN/NOTIFY on bedrock_search_index_queue wakes the drain.';

-- Grants
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bedrock_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.search_doc TO bedrock_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON bedrock.search_index_queue TO bedrock_user;
        GRANT USAGE ON SEQUENCE bedrock.search_index_queue_id_seq TO bedrock_user;
    END IF;
END $$;
