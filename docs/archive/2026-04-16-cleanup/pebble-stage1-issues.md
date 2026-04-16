# Pebble Stage 1 — Issues & Notes

## Trivial Issues Fixed During Testing

1. **Wikipedia 403 errors** — Wikipedia API requires a User-Agent header. Added `PebbleResearch/0.2 (pursuit.org)` to all Wikipedia HTTP calls in `pebble/data_sources/wikipedia.py`.

2. **Career history claim text duplication** — The regex captured titles with trailing prepositions ("mayor of"), then the claim template added another "of" → "served as mayor of of New York". Fixed by stripping trailing prepositions in `wikipedia_parser.py` and using "at" as connector in `claim_templates.py`.

## Non-Trivial Issues (Future Work)

### 1. Jukay Hsu has no Wikipedia page
Jukay Hsu does not have a Wikipedia article. The full article + infobox parsing improvements help significantly for people who DO have Wikipedia pages (tested successfully on Michael Bloomberg — extracted board memberships, career history, education, infobox data). For people without Wikipedia, Pebble relies on other sources (ProPublica, SEC, FEC, USAspending, OpenCorporates).

**Impact**: Board memberships like "Partnership for NYC" and "NYC Water Board" can't come from Wikipedia for Jukay. These would require additional data sources (nonprofit board registries, government appointment databases).

**Recommendation**: Stage 2+ should add ProPublica 990 Part VII parsing (officer/director lists from tax filings) and potentially NYC nonprofit registry lookups.

### 2. Career history regex noise
The regex-based career extraction from Wikipedia article text produces some noise (e.g., "CEO at end of 2014" instead of "CEO at Bloomberg LP"). This is inherent to regex parsing of free-form prose. The LLM synthesis stage should filter these, but structured data from the infobox is more reliable.

**Recommendation**: Weight infobox claims higher than text-extracted career history. Consider NLP entity extraction in a future iteration.

### 3. OpenCorporates API key not configured
OpenCorporates officer search is ready in code but requires an API key. Free tier allows 500 requests/month. The API cache layer (Stage 1C) is in place to help stay within limits.

**Action needed**: User needs to obtain an API key from opencorporates.com and add `OPENCORPORATES_API_KEY=...` to `pebble/.env`.

### 4. PDF export not implemented
Markdown export works and is the primary format. PDF via `weasyprint` was considered too heavy a dependency. The `pebble/export.py` has a `render_profile_pdf()` stub that falls back to markdown bytes if weasyprint isn't installed.

**Recommendation**: Add PDF in a future iteration if needed, or use client-side browser print to PDF.

### 5. Session history does not migrate existing profiles
The new `research_sessions` table only gets populated for NEW research runs. Profiles created before Stage 1 won't appear in the history sidebar.

**Impact**: Minimal — the old profiles are still accessible via direct API call. New research going forward will populate history.

## Verification Summary

| Feature | Status | Notes |
|---------|--------|-------|
| Wikipedia full article parsing | Working | Tested on Michael Bloomberg — infobox, board, career extracted |
| Wikipedia infobox claims | Working | 8 claims generated from Bloomberg's page |
| Temporal accuracy prompts | Updated | All 5 prompt templates modified |
| API response cache | Working | SQLite cache table created, TTL-based |
| Markdown export | Working | Clean formatted output with claims table and sources |
| Session history endpoints | Working | GET /history returns sessions, GET /history/{id} returns full profile |
| Text feedback | Working | Submit with text, retrieve by contact_id, trends endpoint |
| Feedback display on reopen | Working | Previous feedback shown inline with claims |
| History sidebar (frontend) | Deployed | Right-side drawer with session list |
| Download button (frontend) | Deployed | "Download Markdown" on profile card |
| Cancel/Stop button | Working | From previous implementation, still functional |
| TypeScript compilation | Clean | Zero errors |
