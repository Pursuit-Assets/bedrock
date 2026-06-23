"""Annotate jobs opportunities with the sheet's Source + Next Steps as comments,
and reconcile multi-contact companies. Idempotent.

  python -m scripts.annotate_opps_from_sheet           # DRY RUN
  python -m scripts.annotate_opps_from_sheet --commit   # writes comments + links

Reads /tmp/sheet.md (the pipeline table). For each company row with a Source or
Next Steps note, posts ONE jobs_comment on the matching opportunity (resolving
variant-name dupes). Skips rows whose opp already has the sheet-note comment.
"""
import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

DUPE = {
    "acture": "Acture Solutions", "cypress hills": "Cypress Hills Development Corporation",
    "kohlberg": "Kohlberg & Company", "crux capital": "Crux",
    "assured health partners": "Assured Healthcare Partners",
    "bed stuy restoration corp": "Bedstuy Restoration Corporation",
    "emerge careers": "Emerge Career", "charter": "Charter Communications",
    "fowler": "Fowler Laundry Solutions", "cbs": "CBS News",
    "big brothers big sisters": "Big Brothers Big Sisters New Jersey",
}
MARKER = "📋 From pipeline sheet"
AUTHOR = "jac@pursuit.org"


def parse_rows(path="/tmp/sheet.md"):
    rows = []
    for ln in open(path):
        if not ln.startswith("|"):
            continue
        p = [x.strip() for x in ln.split("|")]
        rows.append({"company": p[1], "first": p[2], "last": p[3], "email": p[4],
                     "status": p[11], "notes": p[12], "source": p[13]})
    return rows


def comment_body(source, notes):
    parts = [MARKER]
    if source:
        parts.append(f"Source: {source}")
    if notes:
        parts.append(f"Next steps: {notes}")
    return "\n".join(parts)


async def main(commit: bool):
    import asyncpg
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    opp_by_lc = {r["account_name"].strip().lower(): (r["id"], r["account_name"])
                 for r in await conn.fetch(
                     "SELECT id, account_name FROM bedrock.jobs_opportunity WHERE deleted_at IS NULL")}
    author_id = await conn.fetchval(
        "SELECT id FROM public.org_users WHERE LOWER(email)=LOWER($1) LIMIT 1", AUTHOR)

    rows = parse_rows()
    planned, skipped_no_opp, already = [], [], 0
    for r in rows:
        if not r["company"] or not (r["source"] or r["notes"]):
            continue
        cl = r["company"].lower()
        target = DUPE.get(cl, r["company"]).lower()
        hit = opp_by_lc.get(cl) or opp_by_lc.get(target)
        if not hit:
            skipped_no_opp.append(r["company"]); continue
        opp_id, opp_name = hit
        body = comment_body(r["source"], r["notes"])
        exists = await conn.fetchval(
            "SELECT 1 FROM bedrock.jobs_comment WHERE parent_type='opportunity' AND parent_id=$1 AND content LIKE $2 LIMIT 1",
            str(opp_id), f"{MARKER}%")
        if exists:
            already += 1; continue
        planned.append((opp_name, body))

    print(f"=== comments to post: {len(planned)} (already annotated: {already}; no-opp: {len(skipped_no_opp)}) ===")
    for name, body in planned:
        print(f"  {name[:34]:34} | {body.replace(chr(10), ' · ')[:90]}")
    if skipped_no_opp:
        print(f"  no opp for: {skipped_no_opp}")

    if not commit:
        print("\nDRY RUN — nothing written. Re-run with --commit.")
        await conn.close()
        return

    posted = 0
    async with conn.transaction():
        for r in rows:
            if not r["company"] or not (r["source"] or r["notes"]):
                continue
            cl = r["company"].lower()
            hit = opp_by_lc.get(cl) or opp_by_lc.get(DUPE.get(cl, r["company"]).lower())
            if not hit:
                continue
            opp_id, _ = hit
            body = comment_body(r["source"], r["notes"])
            exists = await conn.fetchval(
                "SELECT 1 FROM bedrock.jobs_comment WHERE parent_type='opportunity' AND parent_id=$1 AND content LIKE $2 LIMIT 1",
                str(opp_id), f"{MARKER}%")
            if exists:
                continue
            await conn.execute(
                """INSERT INTO bedrock.jobs_comment (parent_type, parent_id, author_id, author_email, content)
                   VALUES ('opportunity', $1, $2, $3, $4)""",
                str(opp_id), author_id, AUTHOR, body)
            posted += 1
    print(f"\nPOSTED {posted} comments.")
    await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true")
    args = ap.parse_args()
    load_dotenv()
    asyncio.run(main(args.commit))
