"""Auto-map unmatched email domains to SF accounts using Account.Website.

Called at the end of every interaction sync run. Exactly-one SF Website
match → auto-insert into bedrock.account_email_domain + retroactive backfill.
Multiple matches → logged and skipped (ambiguous). Zero matches → skipped.
"""

import logging
import os

logger = logging.getLogger(__name__)

_NOISE_DOMAINS = frozenset({
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "me.com", "aol.com", "live.com", "msn.com",
    "greenhouse.io", "rose.greenhouse.io", "lever.co", "workday.com",
    "fireflies.ai", "superhuman.com", "mailsuite.com", "calendly.com",
    "substack.com", "mailchimp.com", "constantcontact.com", "sendgrid.net",
    "group.calendar.google.com", "resource.calendar.google.com",
    "groups.outlook.com", "pursuit.org", "pursuit.com", "c4q.nyc",
    "zoom.us", "zoominfo.com", "linkedin.com", "slack.com",
})


def _get_sf():
    from simple_salesforce import Salesforce
    return Salesforce(
        username=os.environ["SALESFORCE_USERNAME"],
        password=os.environ["SALESFORCE_PASSWORD"],
        security_token="",
        domain=os.environ.get("SALESFORCE_DOMAIN", "login"),
        instance_url=os.environ.get("SF_INSTANCE_URL"),
    )


async def auto_enrich_domains(conn) -> dict:
    """Find unmapped domains with >= 3 activity rows, search SF by Website, auto-map exact matches."""

    rows = await conn.fetch("""
        SELECT domain, sum(cnt) AS total
        FROM (
            SELECT
                split_part(
                    CASE WHEN a.email_from LIKE '%<%'
                        THEN lower(rtrim(split_part(a.email_from,'<',2),'> '))
                        ELSE lower(a.email_from) END,
                    '@', 2
                ) AS domain,
                count(*) AS cnt
            FROM bedrock.activity a
            WHERE a.account_id IS NULL
              AND a.source IN ('gmail-sync','calendar-sync')
              AND a.email_from IS NOT NULL
            GROUP BY 1
            UNION ALL
            SELECT
                split_part(lower(att->>'email'),'@',2) AS domain,
                count(*) AS cnt
            FROM bedrock.activity a,
                 jsonb_array_elements(a.meeting_attendees) att
            WHERE a.account_id IS NULL
              AND a.source = 'calendar-sync'
              AND att->>'email' IS NOT NULL
            GROUP BY 1
        ) sub
        WHERE domain != ''
          AND domain LIKE '%.%'
          AND domain NOT IN (SELECT domain FROM bedrock.account_email_domain)
        GROUP BY domain
        HAVING sum(cnt) >= 3
        ORDER BY sum(cnt) DESC
        LIMIT 100
    """)

    if not rows:
        logger.info("domain_enrichment: no new candidate domains")
        return {"auto_mapped": 0, "candidates": 0}

    logger.info("domain_enrichment: %d candidate domains", len(rows))

    try:
        sf = _get_sf()
    except Exception as e:
        logger.error("domain_enrichment: SF connection failed: %s", e)
        return {"auto_mapped": 0, "candidates": len(rows), "error": str(e)}

    auto_mapped = 0

    for row in rows:
        domain = row["domain"]

        if domain in _NOISE_DOMAINS:
            continue
        if not domain or "." not in domain:
            continue
        # Skip subdomain noise like communityaffairs.pnc.com for generic subdomains
        # but allow them if they have activity (caller already filtered)

        try:
            safe = domain.replace("'", "\\'")
            result = sf.query(
                f"SELECT Id, Name, Website FROM Account "
                f"WHERE Website LIKE '%{safe}%' LIMIT 3"
            )
            records = result.get("records", [])

            if len(records) == 1:
                acct = records[0]
                await conn.execute(
                    """
                    INSERT INTO bedrock.account_email_domain (domain, sf_account_id)
                    VALUES ($1, $2)
                    ON CONFLICT (domain) DO NOTHING
                    """,
                    domain,
                    acct["Id"],
                )
                # Retroactive update
                await conn.execute(
                    """
                    UPDATE bedrock.activity
                    SET account_id = $2
                    WHERE account_id IS NULL
                      AND source IN ('gmail-sync', 'calendar-sync')
                      AND (
                        split_part(
                          CASE WHEN email_from LIKE '%<%'
                            THEN lower(rtrim(split_part(email_from,'<',2),'> '))
                            ELSE lower(email_from) END,
                          '@', 2
                        ) = $1
                        OR EXISTS (
                          SELECT 1 FROM jsonb_array_elements(meeting_attendees) att
                          WHERE split_part(lower(att->>'email'),'@',2) = $1
                        )
                      )
                    """,
                    domain,
                    acct["Id"],
                )
                logger.info(
                    "domain_enrichment: mapped %s → %s (%s) [%d activity rows]",
                    domain, acct["Name"], acct["Id"], row["total"],
                )
                auto_mapped += 1

            elif len(records) > 1:
                logger.info(
                    "domain_enrichment: %s ambiguous (%d SF matches): %s",
                    domain,
                    len(records),
                    [r["Name"] for r in records],
                )

        except Exception as e:
            logger.warning("domain_enrichment: SF lookup failed for %s: %s", domain, e)

    logger.info("domain_enrichment: auto-mapped %d / %d domains", auto_mapped, len(rows))
    return {"auto_mapped": auto_mapped, "candidates": len(rows)}
