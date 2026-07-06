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


async def sweep_builder_candidates(conn) -> Dict[str, Any]:
    """Run absorb_if_builder over the whole current review queue (nightly +
    one-off backfill). Returns counts."""
    ids = [r["contact_id"] for r in await conn.fetch(
        "SELECT contact_id FROM public.contacts WHERE contact_stage='candidate' "
        "AND ('email_review' = ANY(coalesce(tags,'{}')) OR source='email_candidate')")]
    absorbed, saved = 0, 0
    for cid in ids:
        res = await absorb_if_builder(conn, cid)
        if res:
            absorbed += 1
            if res["email_result"] == "saved":
                saved += 1
    logger.info("builder sweep: %d absorbed of %d candidates, %d emails saved", absorbed, len(ids), saved)
    return {"scanned": len(ids), "absorbed": absorbed, "emails_saved": saved}
