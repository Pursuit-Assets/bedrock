"""Enrich bedrock.jobs_opportunity.segment from company + domain + industry/size.

Curated map (Claude's classification of the current employer set) takes priority;
a heuristic (industry / size / name+domain patterns) covers anything else and
future opps. Only fills rows where segment IS NULL — never overwrites a value the
team set (so manual overrides stick).

Run:  python -m scripts.enrich_opp_segments          # apply
      python -m scripts.enrich_opp_segments --dry     # preview only
"""
import asyncio
import os
import sys

from dotenv import load_dotenv

# Substring-keyed (handles truncated/variant names). First match wins.
CURATED: list[tuple[str, str]] = [
    ("accenture", "enterprise"), ("acture", "smb"), ("adonis", "startup"),
    ("alley corp", "vc_pe"), ("anthos home", "startup"), ("anthropic", "enterprise"),
    ("apollo", "startup"), ("assured healthcare partners", "vc_pe"),
    ("bedstuy restoration", "nonprofit"), ("bed stuy restoration", "nonprofit"),
    ("big brothers big sisters", "nonprofit"), ("big human", "smb"),
    ("blackstone", "vc_pe"), ("bridgespan", "nonprofit"), ("broccoli", "startup"),
    ("brooklyn public library", "nonprofit"), ("careervillage", "nonprofit"),
    ("cbs news", "enterprise"), ("charter communications", "enterprise"),
    ("citizens bank", "enterprise"), ("con ed", "enterprise"), ("coned", "enterprise"),
    ("coop careers", "nonprofit"), ("crux", "startup"), ("cypress hills", "nonprofit"),
    ("emerge career", "startup"), ("first student", "enterprise"),
    ("food education fund", "nonprofit"), ("fowler laundry", "smb"),
    ("hatra", "smb"), ("imentor", "nonprofit"), ("jp morgan", "enterprise"),
    ("jpmorgan", "enterprise"), ("kohlberg", "vc_pe"), ("macquarie", "enterprise"),
    ("marsh mclennan", "enterprise"), ("mastercard", "enterprise"),
    ("multiplier", "startup"), ("openai", "enterprise"), ("ounce", "startup"),
    ("princeton equity", "vc_pe"), ("queens community house", "nonprofit"),
    ("rxr", "enterprise"), ("salesforce", "enterprise"), ("siegel foundation", "nonprofit"),
    ("tiger tracks", "other"), ("us chamber of commerce", "government"),
    ("vobile", "enterprise"), ("vocal media", "startup"), ("west monroe", "enterprise"),
    ("icl", "nonprofit"),  # Institute for Community Living
]

VC_KW = ("capital", "ventures", "venture", "equity", "partners", "holdings", "asset management")
GOV_KW = ("chamber of commerce", "city of", "state of", "department of")


def heuristic(name: str, domain: str | None, industry: str | None, size: str | None) -> str:
    n = (name or "").lower()
    d = (domain or "").lower()
    if (industry == "Nonprofit") or ".org" in d or "foundation" in n or "nonprofit" in n or n.endswith(" fund"):
        return "nonprofit"
    if ".gov" in d or any(k in n for k in GOV_KW):
        return "government"
    if any(k in n for k in VC_KW):
        return "vc_pe"
    if size in ("1001-5000", "5000+"):
        return "enterprise"
    if industry == "Consulting" and size in ("201-1000", "1001-5000", "5000+"):
        return "enterprise"
    if industry == "Technology" and size in ("1-10", "11-50"):
        return "startup"
    if size in ("1-10", "11-50"):
        return "smb"
    if size in ("51-200", "201-1000"):
        return "enterprise"
    return "other"


def classify(name: str, domain: str | None, industry: str | None, size: str | None) -> str:
    nl = (name or "").lower()
    for key, seg in CURATED:
        if key in nl:
            return seg
    return heuristic(name, domain, industry, size)


async def main(dry: bool) -> None:
    import asyncpg

    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (lower(o.account_name))
                   o.account_name, co.industry, co.size_bucket, co.domain
            FROM bedrock.jobs_opportunity o
            LEFT JOIN public.companies co ON lower(co.name) = lower(o.account_name)
            WHERE o.deleted_at IS NULL AND o.segment IS NULL
            ORDER BY lower(o.account_name), (co.industry IS NULL), (co.size_bucket IS NULL)
            """
        )
        print(f"{len(rows)} companies to classify ({'DRY RUN' if dry else 'applying'}):")
        applied = 0
        for r in rows:
            seg = classify(r["account_name"], r["domain"], r["industry"], r["size_bucket"])
            print(f"  {r['account_name'][:32]:<34} → {seg}")
            if not dry:
                applied += int(
                    (
                        await conn.execute(
                            """UPDATE bedrock.jobs_opportunity
                               SET segment = $1, updated_at = now()
                               WHERE deleted_at IS NULL AND segment IS NULL
                                 AND lower(account_name) = lower($2)""",
                            seg, r["account_name"],
                        )
                    ).split()[-1]
                )
        print(f"\n{'(dry run — nothing written)' if dry else f'rows updated: {applied}'}")
    finally:
        await conn.close()


if __name__ == "__main__":
    load_dotenv()
    asyncio.run(main("--dry" in sys.argv))
