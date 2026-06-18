"""Pass 0 of the data-cleanup exercise — read-only scan of every external
account/contact that has appeared in mail/cal activity.

Reads bedrock.activity (gmail-sync + calendar-sync rows). Aggregates by:
  - email domain → bedrock.activity_scan_domain
  - participant email → bedrock.activity_scan_person

For each, attempts resolution via existing mappings:
  - account_email_domain         (domain → SF Account)
  - public.contacts + sf_contact_link (email → SF Contact + Account)
  - public.companies bridge      (domain → public.companies → SF Account)
  - sync_staff (primary + aliases) → internal staff filter
  - five Pursuit-owned domains   → internal fallback

Output: two scan tables + a summary report. Idempotent (TRUNCATE+INSERT per run).

Run:
    python -m scripts.scan_activity_universe                  # uses current activity
    python -m scripts.scan_activity_universe --since 90        # restrict window (days)
"""
import argparse
import asyncio
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('scan')

# ── Internal-domain filter ─────────────────────────────────────────
PURSUIT_DOMAINS = {
    'pursuit.org',
    'pursuit.com',
    'coalitionforqueens.org',
    'c4q.nyc',
    'ac.c4q.nyc',
}

# ── Heuristic noise prefilter ──────────────────────────────────────
NOISE_LOCAL_RE = re.compile(
    r'^(no.?reply|do.?not.?reply|noreply|reply\+|mailer.?daemon|postmaster|'
    r'bounce|delivery|notifications?|alerts?|automated|system|info|admin|'
    r'support|help|hello|hi|team|customer|service|contact|sales|marketing)$',
    re.IGNORECASE,
)
NOISE_DOMAINS = {
    'resource.calendar.google.com',
    'group.calendar.google.com',
    'meet.google.com',
    'chime.aws',
    'webex.com',
    'zoom.us',
    'calendly.com',
    'cal.com',
}


def normalize_domain(d: str) -> str:
    """Lowercase, strip www. and known mailing-list/cdn prefixes."""
    d = (d or '').strip().lower()
    if d.startswith('www.'):
        d = d[4:]
    return d


def is_pursuit_internal(email: str, internal_set: set) -> bool:
    e = (email or '').strip().lower()
    if e in internal_set:
        return True
    domain = e.split('@', 1)[1] if '@' in e else ''
    return normalize_domain(domain) in PURSUIT_DOMAINS


def is_noise_heuristic(email: str) -> bool:
    e = (email or '').strip().lower()
    if '@' not in e:
        return True
    local, domain = e.split('@', 1)
    domain = normalize_domain(domain)
    if domain in NOISE_DOMAINS:
        return True
    if NOISE_LOCAL_RE.match(local):
        return True
    # Common automated-sender patterns
    if any(pat in local for pat in ('mailer-', 'postmaster-', 'noreply-', 'bounce-')):
        return True
    return False


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS bedrock.activity_scan_domain (
    domain                     TEXT PRIMARY KEY,
    first_seen_at              TIMESTAMPTZ NOT NULL,
    last_seen_at               TIMESTAMPTZ NOT NULL,
    activity_count             INT NOT NULL DEFAULT 0,
    distinct_people            INT NOT NULL DEFAULT 0,
    source_breakdown           JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolved_sf_account_id     TEXT,
    resolved_via               TEXT,
    public_company_id          INTEGER,
    suggested_action           TEXT NOT NULL,
    suggested_reason           TEXT,
    scanned_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_scan_domain_action ON bedrock.activity_scan_domain (suggested_action);

CREATE TABLE IF NOT EXISTS bedrock.activity_scan_person (
    email                       TEXT PRIMARY KEY,
    domain                      TEXT NOT NULL,
    display_name                TEXT,
    first_seen_at               TIMESTAMPTZ NOT NULL,
    last_seen_at                TIMESTAMPTZ NOT NULL,
    activity_count              INT NOT NULL DEFAULT 0,
    resolved_sf_contact_id      TEXT,
    resolved_public_contact_id  INTEGER,
    resolved_sf_account_id      TEXT,
    suggested_action            TEXT NOT NULL,
    suggested_reason            TEXT,
    scanned_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_scan_person_domain ON bedrock.activity_scan_person (domain);
CREATE INDEX IF NOT EXISTS idx_activity_scan_person_action ON bedrock.activity_scan_person (suggested_action);
"""


async def main(since_days: Optional[int]) -> None:
    db_url = os.environ['DATABASE_URL']
    pool = await asyncpg.create_pool(db_url, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            # Tables use TEXT (lowercased in Python). We don't have CREATE
            # EXTENSION on the shared segundo-db, and CITEXT isn't worth the
            # privilege ask — explicit normalization gives the same result.
            await conn.execute(SCHEMA_SQL)

            # Build the internal-email set (sync_staff primaries + aliases)
            staff_rows = await conn.fetch("SELECT email, aliases FROM bedrock.sync_staff")
            internal_set = set()
            for r in staff_rows:
                internal_set.add(r['email'].lower())
                for a in (r['aliases'] or []):
                    internal_set.add(a.lower())
            logger.info("internal-email set size: %d (primaries + aliases)", len(internal_set))

            # Build the SF Account-domain map for fast resolution
            aed_rows = await conn.fetch(
                "SELECT domain, sf_account_id FROM bedrock.account_email_domain"
            )
            domain_to_acct = {r['domain'].lower(): r['sf_account_id'] for r in aed_rows}
            logger.info("account_email_domain rows: %d", len(domain_to_acct))

            # Build the public.companies map (domain → company_id)
            try:
                pc_rows = await conn.fetch(
                    "SELECT domain, company_id FROM public.companies WHERE domain IS NOT NULL"
                )
                domain_to_company = {r['domain'].lower(): r['company_id'] for r in pc_rows}
                logger.info("public.companies with domain: %d", len(domain_to_company))
            except Exception as e:
                logger.warning("could not read public.companies (%s) — continuing without enrichment", e)
                domain_to_company = {}

            # Pull activity rows we care about
            where = "source IN ('gmail-sync', 'calendar-sync')"
            params = []
            if since_days:
                cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
                where += " AND activity_date >= $1"
                params.append(cutoff)
            sql = f"""
                SELECT source, activity_date, email_from, email_to, meeting_attendees, account_id
                FROM bedrock.activity
                WHERE {where}
            """
            rows = await conn.fetch(sql, *params)
            logger.info("activity rows in scope: %d", len(rows))

            # ── Aggregate ────────────────────────────────────────────────
            from collections import defaultdict
            per_email = defaultdict(lambda: {
                'count': 0, 'first': None, 'last': None,
            })
            per_domain = defaultdict(lambda: {
                'count': 0, 'first': None, 'last': None,
                'people': set(), 'sources': defaultdict(int),
            })

            def extract_emails(row):
                out = []
                f = (row['email_from'] or '').strip()
                if f:
                    # email_from can be "Name <addr@x.com>" or just "addr@x.com"
                    m = re.search(r'<([^>]+)>', f)
                    out.append((m.group(1) if m else f).strip().lower())
                for t in (row['email_to'] or []):
                    out.append((t or '').strip().lower())
                for att in (row['meeting_attendees'] or []):
                    if isinstance(att, dict):
                        em = (att.get('email') or '').strip().lower()
                        if em:
                            out.append(em)
                    elif isinstance(att, str):
                        out.append(att.strip().lower())
                # Reject empties, bare '@', and missing-part variants like '@x' or 'x@'.
                # Also require a dot in the domain portion (rules out localhost / Slack-internal addresses).
                def valid(e):
                    if '@' not in e:
                        return False
                    local, _, domain = e.partition('@')
                    return bool(local) and bool(domain) and '.' in domain
                return [e for e in out if valid(e)]

            for r in rows:
                ts = r['activity_date']
                emails = extract_emails(r)
                for em in emails:
                    domain = em.split('@', 1)[1] if '@' in em else ''
                    domain = normalize_domain(domain)
                    pe = per_email[em]
                    pe['count'] += 1
                    pe['first'] = ts if pe['first'] is None else min(pe['first'], ts)
                    pe['last'] = ts if pe['last'] is None else max(pe['last'], ts)
                    pd = per_domain[domain]
                    pd['count'] += 1
                    pd['first'] = ts if pd['first'] is None else min(pd['first'], ts)
                    pd['last'] = ts if pd['last'] is None else max(pd['last'], ts)
                    pd['people'].add(em)
                    pd['sources'][r['source']] += 1

            logger.info("aggregated: %d distinct emails, %d distinct domains",
                        len(per_email), len(per_domain))

            # ── Resolve + classify ──────────────────────────────────────
            import json as _json
            await conn.execute("TRUNCATE bedrock.activity_scan_domain, bedrock.activity_scan_person")

            for domain, agg in per_domain.items():
                if not domain:
                    continue
                if domain in PURSUIT_DOMAINS:
                    action, reason = 'internal', 'pursuit-owned domain'
                    resolved_acct, via, company = None, None, None
                elif domain in NOISE_DOMAINS:
                    action, reason = 'noise', 'system/calendar domain'
                    resolved_acct, via, company = None, None, None
                elif domain in domain_to_acct:
                    action, reason = 'mapped', 'in account_email_domain'
                    resolved_acct = domain_to_acct[domain]
                    via = 'account_email_domain'
                    company = domain_to_company.get(domain)
                elif domain in domain_to_company:
                    action, reason = 'needs_backfill', 'public.companies match, missing account_email_domain'
                    resolved_acct = None
                    via = 'public.companies'
                    company = domain_to_company[domain]
                else:
                    action, reason = 'candidate', 'no SF or public match'
                    resolved_acct, via, company = None, None, None

                await conn.execute(
                    """
                    INSERT INTO bedrock.activity_scan_domain (
                        domain, first_seen_at, last_seen_at, activity_count, distinct_people,
                        source_breakdown, resolved_sf_account_id, resolved_via, public_company_id,
                        suggested_action, suggested_reason
                    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
                    ON CONFLICT (domain) DO UPDATE SET
                        first_seen_at = EXCLUDED.first_seen_at,
                        last_seen_at = EXCLUDED.last_seen_at,
                        activity_count = EXCLUDED.activity_count,
                        distinct_people = EXCLUDED.distinct_people,
                        source_breakdown = EXCLUDED.source_breakdown,
                        resolved_sf_account_id = EXCLUDED.resolved_sf_account_id,
                        resolved_via = EXCLUDED.resolved_via,
                        public_company_id = EXCLUDED.public_company_id,
                        suggested_action = EXCLUDED.suggested_action,
                        suggested_reason = EXCLUDED.suggested_reason,
                        scanned_at = now()
                    """,
                    domain, agg['first'], agg['last'], agg['count'], len(agg['people']),
                    _json.dumps(dict(agg['sources'])), resolved_acct, via, company,
                    action, reason,
                )

            # Bulk public.contacts lookup for resolution
            emails_list = list(per_email.keys())
            try:
                contact_rows = await conn.fetch(
                    """
                    SELECT LOWER(c.email) AS email, c.contact_id AS public_id,
                           scl.sf_contact_id, scl.sf_account_id
                    FROM public.contacts c
                    LEFT JOIN bedrock.sf_contact_link scl
                        ON scl.public_contact_id = c.contact_id
                    WHERE LOWER(c.email) = ANY($1::text[])
                    """,
                    emails_list,
                )
                contact_lookup = {r['email']: r for r in contact_rows}
            except Exception as e:
                logger.warning("public.contacts lookup failed: %s", e)
                contact_lookup = {}

            for email, agg in per_email.items():
                domain = email.split('@', 1)[1] if '@' in email else ''
                domain = normalize_domain(domain)

                if is_pursuit_internal(email, internal_set):
                    action, reason = 'internal', 'staff / pursuit-domain'
                    sf_contact, public_id, sf_acct = None, None, None
                elif is_noise_heuristic(email):
                    action, reason = 'noise', 'matches heuristic pattern'
                    sf_contact, public_id, sf_acct = None, None, None
                elif email in contact_lookup:
                    cl = contact_lookup[email]
                    public_id = cl['public_id']
                    sf_contact = cl['sf_contact_id']
                    sf_acct = cl['sf_account_id'] or domain_to_acct.get(domain)
                    if sf_contact:
                        action = 'mapped'; reason = 'linked SF contact'
                    elif public_id:
                        action = 'needs_backfill'; reason = 'in public.contacts, no SF link'
                    else:
                        action = 'candidate'; reason = 'unexpected'
                else:
                    action = 'candidate'; reason = 'no SF or public match'
                    sf_contact, public_id, sf_acct = None, None, domain_to_acct.get(domain)

                await conn.execute(
                    """
                    INSERT INTO bedrock.activity_scan_person (
                        email, domain, first_seen_at, last_seen_at, activity_count,
                        resolved_sf_contact_id, resolved_public_contact_id,
                        resolved_sf_account_id, suggested_action, suggested_reason
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    ON CONFLICT (email) DO UPDATE SET
                        domain = EXCLUDED.domain,
                        first_seen_at = EXCLUDED.first_seen_at,
                        last_seen_at = EXCLUDED.last_seen_at,
                        activity_count = EXCLUDED.activity_count,
                        resolved_sf_contact_id = EXCLUDED.resolved_sf_contact_id,
                        resolved_public_contact_id = EXCLUDED.resolved_public_contact_id,
                        resolved_sf_account_id = EXCLUDED.resolved_sf_account_id,
                        suggested_action = EXCLUDED.suggested_action,
                        suggested_reason = EXCLUDED.suggested_reason,
                        scanned_at = now()
                    """,
                    email, domain, agg['first'], agg['last'], agg['count'],
                    sf_contact, public_id, sf_acct, action, reason,
                )

            # ── Summary report ──────────────────────────────────────────
            dom_summary = await conn.fetch(
                "SELECT suggested_action, COUNT(*) AS n, "
                "SUM(activity_count) AS activity, SUM(distinct_people) AS people "
                "FROM bedrock.activity_scan_domain GROUP BY suggested_action ORDER BY n DESC"
            )
            person_summary = await conn.fetch(
                "SELECT suggested_action, COUNT(*) AS n, SUM(activity_count) AS activity "
                "FROM bedrock.activity_scan_person GROUP BY suggested_action ORDER BY n DESC"
            )
            print("\n=== domains ===")
            for r in dom_summary:
                print(f"  {r['suggested_action']:<16} count={r['n']:<6} activity={r['activity']:<8} people={r['people']}")
            print("\n=== people ===")
            for r in person_summary:
                print(f"  {r['suggested_action']:<16} count={r['n']:<6} activity={r['activity']}")
            print()
            logger.info("scan complete")
    finally:
        await pool.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', type=int, default=None,
                    help='Restrict to activity within last N days (default: all)')
    args = ap.parse_args()
    asyncio.run(main(args.since))
