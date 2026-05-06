-- 2026-05-06: source-table triggers wiring bedrock entities to the
-- search index queue.
--
-- Layer 1.6 of the Pebble 1.0 plan. Adds AFTER-INSERT/UPDATE/DELETE
-- triggers on the bedrock-side source tables so every write enqueues
-- a search_index_queue row. The indexer worker drains the queue and
-- composes search_doc rows.
--
-- Sources wired in this migration:
--   * bedrock.project                  → entity_type 'bedrock_project'
--   * bedrock.saved_view               → entity_type 'bedrock_saved_view'
--   * bedrock.pebble_research_sessions → entity_type 'pebble_profile'
--                                        (only when status='completed' —
--                                         in-progress sessions don't
--                                         appear in search)
--
-- SF-mirrored sources (Account, Contact, Opportunity, Task, Activity)
-- get wired in a separate migration once the SF mirror tables exist
-- (Layer 1.4). Award (bedrock.award) is wired here too — name is
-- composed from the linked Opportunity which we don't yet mirror; for
-- v1 the composer can defer until Layer 1.4 lands.
--
-- Idempotent — DROP TRIGGER IF EXISTS before each CREATE.

-- ---------------------------------------------------------------------------
-- bedrock.project
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_project_search_index ON bedrock.project;
CREATE TRIGGER trg_project_search_index
    AFTER INSERT OR UPDATE OR DELETE ON bedrock.project
    FOR EACH ROW EXECUTE FUNCTION bedrock.enqueue_search_index('bedrock_project');

-- ---------------------------------------------------------------------------
-- bedrock.saved_view
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_saved_view_search_index ON bedrock.saved_view;
CREATE TRIGGER trg_saved_view_search_index
    AFTER INSERT OR UPDATE OR DELETE ON bedrock.saved_view
    FOR EACH ROW EXECUTE FUNCTION bedrock.enqueue_search_index('bedrock_saved_view');

-- ---------------------------------------------------------------------------
-- bedrock.pebble_research_sessions
--
-- Only enqueue when status transitions into 'completed' OR for
-- already-completed rows on UPDATE. In-progress sessions don't appear
-- in search; the composer would return None and we'd waste a queue
-- cycle. Use a WHEN clause to short-circuit at the trigger.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_pebble_research_sessions_search_index ON bedrock.pebble_research_sessions;
CREATE TRIGGER trg_pebble_research_sessions_search_index
    AFTER INSERT OR UPDATE ON bedrock.pebble_research_sessions
    FOR EACH ROW
    WHEN (NEW.status = 'completed')
    EXECUTE FUNCTION bedrock.enqueue_search_index('pebble_profile');

-- DELETE needs its own trigger since OLD-only refs aren't valid in
-- the WHEN clause for AFTER-DELETE (NEW is null).
DROP TRIGGER IF EXISTS trg_pebble_research_sessions_search_delete ON bedrock.pebble_research_sessions;
CREATE TRIGGER trg_pebble_research_sessions_search_delete
    AFTER DELETE ON bedrock.pebble_research_sessions
    FOR EACH ROW EXECUTE FUNCTION bedrock.enqueue_search_index('pebble_profile');

-- ---------------------------------------------------------------------------
-- bedrock.award
--
-- The composer for entity_type='bedrock_award' isn't shipped yet
-- (needs Opp.Name from a future SF mirror). We still wire the trigger
-- so by the time the composer lands, the queue has every existing
-- award row already enqueued — no separate backfill pass needed.
--
-- Until the composer is registered, the indexer logs
-- 'no_composer' and leaves the queue row in place (silent skip,
-- no failure bump). Confirmed in test_drain_once_no_composer_leaves_queue_intact.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_award_search_index ON bedrock.award;
CREATE TRIGGER trg_award_search_index
    AFTER INSERT OR UPDATE OR DELETE ON bedrock.award
    FOR EACH ROW EXECUTE FUNCTION bedrock.enqueue_search_index('bedrock_award');
