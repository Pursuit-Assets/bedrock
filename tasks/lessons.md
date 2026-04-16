# Lessons Learned

> Updated after every correction or mistake. Patterns to avoid repeating.
> Review at session start.

## 2026-04-15 — Pipeline Flow rework (4 lessons)

1. **Don't propose superset/approximate compromises for user-facing analysis.** My original Pipeline Flow plan said "for custom date ranges, the AI Analyze endpoint sees a wider window than the overlay — acceptable compromise, note with a code comment, defer proper fix." JP rejected it: "enable Analyze to work with any selection of Users or other filters on." The right move was to extend the backend endpoint to accept `start`/`end` explicitly, not paper over the semantic gap. **Rule**: when the on-screen number and the AI's input to an explanation of that number aren't the same, that's a bug, not a compromise — fix the backend.

2. **Regex-validated inputs let you interpolate into SOQL safely without escaping.** Follows the existing `validate_salesforce_id` / `_SF_ID_PATTERN` pattern at `security.py:8`. For dates: `re.compile(r'^\d{4}-\d{2}-\d{2}$')` — digits and hyphen only, no quote, no whitespace, no wildcard, no SOQL keyword. Constructing `CreatedDate >= {start}T00:00:00Z` is then injection-safe. **Document the discipline in the comment** at the interpolation site so reviewers can audit. Don't reach for `escape_soql_string` when the regex has already excluded every SOQL-breaking character — escaping would add noise without adding safety.

3. **React hooks' `useEffect` with deps on a later-declared `useMemo` triggers a TDZ error.** `useEffect(cb, [ownerProgress])` where `ownerProgress` is `const ownerProgress = useMemo(...)` below — the deps array is evaluated immediately during render, before the memo's `const` binding exists. Fix: move the `useEffect` below the memo. Don't try to work around with refs or initial-render guards; just reorder.

4. **SF datetime string `"2026-04-01T10:00:00.000+0000"` ≠ JS `toISOString()` `"…Z"` under lexical compare.** When client-filtering a SF `CreatedDate` range, `parseISO(h.CreatedDate).getTime()` vs `rangeStart.getTime()` — always parse both sides to `Date`, never compare as strings. Learned from the `history.filter` in `PipelineFunnel.tsx`.

## 2026-03-26 — M7 Projects QA (2 bugs)

1. **useEffect dependency arrays: don't include both a list and a selected-item.** If a useEffect validates `selectedId` against `items[]`, and depends on `[items, selectedId]`, it fires when `selectedId` changes — but `items` may be stale (async refetch in flight). The effect sees the new ID isn't in the old list and resets selection. Fix: use functional updater in setState to read latest state, depend only on `[items]`.

2. **Salesforce API returns PascalCase keys.** The `globalSearch` endpoint returns `{Opportunity: [], Contact: [], Account: [], Task: []}`. Always use PascalCase when accessing these — don't guess lowercase. `GlobalSearch.tsx` does this correctly; new code should match its pattern, not invent a new one.

## 2026-03-25 — GCal Calendar Fix (3 layered bugs)

1. **Don't gate data fetches on UI collapse state.** The calendar `useQuery` had `enabled: !prefs.collapsed['calendar']`, but the desktop layout (CalendarInboxSplit) has its own resizable-panel collapse that's independent of `prefs.collapsed['calendar']`. Result: user sees the calendar panel but data never loads. Fix: removed the `enabled` gate — always fetch, staleTime handles frequency.

2. **Set `expiry` on `google.oauth2.credentials.Credentials`.** Without it, `creds.expired` is always `False` and proactive token refresh never fires. The `expires_at` unix timestamp from Authlib must be converted to a **naive UTC datetime** (`datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)`) because google-auth's `_helpers.utcnow()` returns naive. Timezone-aware expiry raises `TypeError`.

3. **Don't return HTTP 500 for calendar errors.** React-query sees 500 → `calResponse` is `undefined` → no error shown. Return structured JSON `{data:[], error:"..."}` so the frontend can display it. Separate `calNeedsReauth` (token expired) from `calErrorMsg` (general error) in the frontend.

## 2026-03-18 — Production-Grade Security MVP

- **JWT and Fernet**: Both must derive from the same `JWT_SECRET_KEY`. Define it once early (after load_dotenv), use everywhere.
- **Production secret**: When `FRONTEND_URL` starts with `https`, fail fast if `JWT_SECRET_KEY` is missing or < 32 chars.
- **Dev bypass**: REMOVED 2026-04-08. The `REACT_APP_DEV_BYPASS` branch in `AuthContext.tsx` was stripped entirely. Multi-layer guards (REACT_APP env var + localhost runtime check + NODE_ENV !== 'production') were structurally safe but added attack surface for no real benefit. All environments now require real Google OAuth — local dev included.
- **Calendar**: Restrict to PBD server-side; reject `primary` and arbitrary calendar IDs. Surface re-auth UX when tokens expire.

