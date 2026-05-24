"""Export research profiles as Markdown (and optionally PDF in the future).

Renders the F5 sentence-level citations, F7 conflicts, F9 evidence
fingerprint, F13 source tier, and the deterministic confidence score
so a development officer reading the brief has the full audit trail
inline — every assertion linked to the claim(s) it draws from, every
disputed role flagged.
"""

from datetime import datetime, timezone


_TIER_LABELS = {
    0: "primary .gov/.edu",
    1: "established aggregator",
    2: "Wikipedia mainspace",
    3: "general web",
}


def _claim_id_for(claim: dict, idx_1based: int) -> str:
    return claim.get("claim_id") or f"c{idx_1based - 1}"


def render_profile_markdown(
    profile: dict, prospect_name: str, prospect_org: str,
) -> str:
    """Render a research profile as a Markdown document."""
    lines: list[str] = []
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    confidence = profile.get("confidence_score", "unknown")
    claims = profile.get("claims", []) or []
    summary_sentences = profile.get("summary_sentences", []) or []
    conflicts = profile.get("conflicts", []) or []
    fingerprint = profile.get("claim_pool_fingerprint", "")

    # Header
    lines.append(f"# Prospect Research: {prospect_name}")
    if prospect_org:
        lines.append(f"**Organization:** {prospect_org}")
    lines.append(f"**Generated:** {generated}")
    lines.append(f"**Confidence:** {confidence}")
    if profile.get("partial"):
        failed = profile.get("failed_agents") or []
        failed_str = ", ".join(failed) if failed else "some agents failed"
        lines.append(f"**Status:** Partial ({failed_str})")
    if conflicts:
        lines.append(f"**Conflicts detected:** {len(conflicts)}")
    lines.append("")

    # Summary — prefer sentence-level (F5) with inline citation refs.
    if summary_sentences:
        lines.append("## Summary")
        lines.append("")
        for sent in summary_sentences:
            text = (sent.get("text") or "").strip()
            cites = sent.get("citations") or []
            if not text:
                continue
            cite_refs = " ".join(f"[[{c}]]" for c in cites)
            if cite_refs:
                lines.append(f"{text} {cite_refs}")
            else:
                lines.append(text)
        lines.append("")
    elif profile.get("summary"):
        lines.append("## Summary")
        lines.append("")
        lines.append(profile["summary"])
        lines.append("")

    # Conflicts (F7) — surface disputes inline so a development officer
    # sees them BEFORE skimming the claim table.
    if conflicts:
        lines.append("## Disputed claims")
        lines.append("")
        for c in conflicts:
            desc = c.get("description", "")
            cids = c.get("claim_ids") or []
            cids_str = ", ".join(f"`{cid}`" for cid in cids)
            lines.append(f"- {desc} ({cids_str})")
        lines.append("")

    # Claims table
    if claims:
        lines.append(f"## Claims ({len(claims)})")
        lines.append("")
        lines.append("| ID | Claim | Source | Tier | Confidence | Quorum | URL |")
        lines.append("|----|-------|--------|------|------------|--------|-----|")
        for idx, claim in enumerate(claims, 1):
            cid = _claim_id_for(claim, idx)
            text = (claim.get("text") or "").replace("|", "\\|").replace("\n", " ")
            url = claim.get("source_url", "")
            source_link = f"[Link]({url})" if url else "-"
            tier = claim.get("source_tier")
            tier_label = (
                f"{tier} — {_TIER_LABELS.get(tier, '?')}"
                if isinstance(tier, int) else "-"
            )
            conf = claim.get("confidence", "medium")
            votes = claim.get("verification_votes")
            n_succ = claim.get("verifiers_successful")
            quorum = (
                f"{votes}/{n_succ}"
                if votes is not None and n_succ is not None else "-"
            )
            url_status = claim.get("url_verification_status", "")
            lines.append(
                f"| `{cid}` | {text} | {source_link} | {tier_label} | "
                f"{conf} | {quorum} | {url_status} |"
            )
        lines.append("")

    # Sources list (unique URLs)
    urls = sorted({c.get("source_url", "") for c in claims if c.get("source_url")})
    if urls:
        lines.append("## Sources")
        lines.append("")
        for url in urls:
            lines.append(f"- {url}")
        lines.append("")

    # Evidence fingerprint (F9) — at the tail so reviewers can diff
    # two runs of the same prospect deterministically.
    if fingerprint:
        lines.append("---")
        lines.append(f"_Evidence fingerprint: `{fingerprint[:16]}…`_")
        lines.append("")

    return "\n".join(lines)


def render_profile_pdf(markdown_text: str) -> bytes:
    """Best-effort PDF rendering from markdown text.

    Falls back to returning the markdown as UTF-8 bytes if PDF libraries
    are not available.
    """
    try:
        import markdown as md

        html = md.markdown(markdown_text, extensions=["tables"])
        full_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
body {{ font-family: sans-serif; margin: 2em; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ccc; padding: 6px 10px; text-align: left; }}
th {{ background: #f5f5f5; }}
</style></head><body>{html}</body></html>"""

        try:
            from weasyprint import HTML
            return HTML(string=full_html).write_pdf()
        except ImportError:
            return markdown_text.encode("utf-8")
    except ImportError:
        return markdown_text.encode("utf-8")
