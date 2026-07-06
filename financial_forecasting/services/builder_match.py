"""Detect candidates who are actually Pursuit builders and absorb them.

A review candidate that resolves (by unique exact name) to a builder isn't an
employer contact — it's one of our own fellows emailing from a personal
address. In that case:
  - save the address onto the builder's user record as backup_email (personal),
    unless it's a pursuit.org address (already their primary) or backup_email
    is already set — never overwrite;
  - drop the candidate out of the review queue (contact_stage='dismissed',
    email_review tag removed). Activity/aliases stay linked.

Matching is conservative: unique exact full-name match only (via the
SECURITY DEFINER bedrock.match_builder_by_name), so common-name collisions
are left in the queue rather than mis-absorbed.
"""
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


async def absorb_if_builder(conn, contact_id: int) -> Optional[Dict[str, Any]]:
    """If this candidate uniquely matches a builder, save the email + dismiss.
    Returns a summary dict when absorbed, else None."""
    c = await conn.fetchrow(
        "SELECT contact_id, full_name, email FROM public.contacts WHERE contact_id=$1", contact_id)
    if not c:
        return None
    name = (c["full_name"] or "").strip()
    if not name or "@" in name or len(name.split()) < 2:
        return None  # need a real two-part name to match safely
    matches = await conn.fetch("SELECT user_id, email, backup_email FROM bedrock.match_builder_by_name($1)", name)
    if len(matches) != 1:
        return None  # 0 or ambiguous → leave in queue
    b = matches[0]
    email_result = "noop"
    if c["email"]:
        email_result = await conn.fetchval(
            "SELECT bedrock.save_builder_backup_email($1, $2)", b["user_id"], c["email"])
    await conn.execute(
        "UPDATE public.contacts SET contact_stage='dismissed', "
        "tags=array_remove(coalesce(tags,'{}'), 'email_review'), updated_at=now() "
        "WHERE contact_id=$1 AND contact_stage='candidate'", contact_id)
    logger.info("absorbed builder candidate %s (%s) → user %s [%s]",
                contact_id, c["email"], b["user_id"], email_result)
    return {"contact_id": contact_id, "builder_user_id": b["user_id"],
            "email": c["email"], "email_result": email_result}


async def absorb_if_known_contact(conn, contact_id: int):
    """If the candidate's name UNIQUELY matches an existing Salesforce-linked
    contact (i.e. a curated SF record — fellows/alumni/known people, per the
    review: "anyone who was in Salesforce"), merge the candidate into it rather
    than leaving it in review. Gated on sf_contact_link so we never auto-merge
    into a random LinkedIn-import namesake; unique match only. Returns a summary
    when linked, else None."""
    c = await conn.fetchrow(
        "SELECT contact_id, full_name, email FROM public.contacts WHERE contact_id=$1", contact_id)
    if not c:
        return None
    name = (c["full_name"] or "").strip()
    if not name or "@" in name or len(name.split()) < 2:
        return None
    rows = await conn.fetch(
        """SELECT d.contact_id FROM public.contacts d
           JOIN bedrock.sf_contact_link l ON l.public_contact_id = d.contact_id
           WHERE lower(d.full_name) = lower($1) AND d.contact_id <> $2
             AND coalesce(d.contact_stage,'') NOT IN ('merged','candidate','dismissed')""",
        name, contact_id)
    canon_ids = sorted({r["contact_id"] for r in rows})
    if len(canon_ids) != 1:
        return None  # 0 or ambiguous → leave in queue
    canonical = canon_ids[0]
    await conn.execute("SELECT bedrock.merge_contacts($1, $2, $3)",
                       canonical, contact_id, "auto-link: exact name match to Salesforce contact")
    logger.info("auto-linked candidate %s (%s) → SF contact %s", contact_id, c["email"], canonical)
    return {"contact_id": contact_id, "linked_to": canonical}


async def sweep_builder_candidates(conn) -> Dict[str, Any]:
    """Absorb known people out of the review queue (nightly + one-off backfill):
    builders (users roster) get their personal email saved + dismissed;
    Salesforce-linked fellows/alumni get the candidate merged into them.
    Everyone else stays for human review. Returns counts."""
    ids = [r["contact_id"] for r in await conn.fetch(
        "SELECT contact_id FROM public.contacts WHERE contact_stage='candidate' "
        "AND ('email_review' = ANY(coalesce(tags,'{}')) OR source='email_candidate')")]
    builders, sf_linked, saved = 0, 0, 0
    for cid in ids:
        res = await absorb_if_builder(conn, cid)
        if res:
            builders += 1
            if res["email_result"] == "saved":
                saved += 1
            continue
        if await absorb_if_known_contact(conn, cid):
            sf_linked += 1
    logger.info("known-people sweep: %d builders absorbed (%d emails saved), %d merged into SF contacts, of %d",
                builders, saved, sf_linked, len(ids))
    return {"scanned": len(ids), "builders_absorbed": builders, "emails_saved": saved,
            "sf_contacts_linked": sf_linked}
