"""Claim templates: structured data → claims without LLM. Each returns list of {text, source_url, confidence, data_as_of, source_currency}."""

import urllib.parse

from .name_match import validate_org_name, validate_person_name

MAX_CLAIMS = 10


def claims_from_fec(
    results: list | None,
    *,
    prospect_name: str | None = None,
) -> list[dict]:
    """FEC individual contributions → claims (used by T1 for quick individual claims).

    F4: when ``prospect_name`` is provided, drops records whose
    ``contributor_name`` doesn't pass ``validate_person_name`` — defends
    against attaching a different "Jane Smith"'s donations to this
    prospect."""
    if not results:
        return []
    claims = []
    for r in results[:MAX_CLAIMS]:
        name = r.get("contributor_name")
        amount = r.get("contribution_receipt_amount")
        committee = r.get("committee", {}).get("name") if isinstance(r.get("committee"), dict) else r.get("committee_name", "")
        date = r.get("contribution_receipt_date", "")
        if not name or amount is None:
            continue
        if prospect_name and not validate_person_name(prospect_name, str(name)):
            continue
        encoded_name = urllib.parse.quote(str(name))
        claims.append({
            "text": f"{name} contributed ${amount:,.2f} to {committee} on {date}" if isinstance(amount, (int, float)) else f"{name} contributed {amount} to {committee} on {date}",
            "source_url": f"https://www.fec.gov/data/receipts/individual-contributions/?contributor_name={encoded_name}",
            "confidence": "high",
            "origin": "template",
            "data_as_of": date or None,
            "source_currency": "real_time",
        })
    return claims


def claims_from_fec_summary(results: list | None) -> list[dict]:
    """FEC individual contributions → 1-3 aggregated summary claims (used by Financial Cluster)."""
    if not results:
        return []

    valid = [r for r in results if r.get("contributor_name") and r.get("contribution_receipt_amount") is not None]
    if not valid:
        return []

    name = valid[0].get("contributor_name", "")
    encoded_name = urllib.parse.quote(str(name))
    source_url = f"https://www.fec.gov/data/receipts/individual-contributions/?contributor_name={encoded_name}"

    # Aggregate totals
    total = sum(float(r.get("contribution_receipt_amount", 0)) for r in valid if isinstance(r.get("contribution_receipt_amount"), (int, float)))
    dates = [r.get("contribution_receipt_date", "") for r in valid if r.get("contribution_receipt_date")]
    years = sorted({d[:4] for d in dates if len(d) >= 4})
    latest_date = max(dates) if dates else None
    year_range = f"{years[0]}-{years[-1]}" if len(years) > 1 else (years[0] if years else "")

    claims = []

    # Claim 1: Total giving summary
    claims.append({
        "text": f"{name} contributed ${total:,.0f} across {len(valid)} donations ({year_range})" if year_range else f"{name} contributed ${total:,.0f} across {len(valid)} donations",
        "source_url": source_url,
        "confidence": "high",
        "origin": "template",
        "data_as_of": latest_date,
        "source_currency": "real_time",
    })

    # Claim 2: Top recipients (up to 3)
    committee_totals: dict[str, float] = {}
    for r in valid:
        committee = r.get("committee", {}).get("name") if isinstance(r.get("committee"), dict) else r.get("committee_name", "")
        if committee and isinstance(r.get("contribution_receipt_amount"), (int, float)):
            committee_totals[committee] = committee_totals.get(committee, 0) + float(r["contribution_receipt_amount"])
    if committee_totals:
        top = sorted(committee_totals.items(), key=lambda x: x[1], reverse=True)[:3]
        parts = [f"{c} (${a:,.0f})" for c, a in top]
        claims.append({
            "text": f"Top recipients: {', '.join(parts)}",
            "source_url": source_url,
            "confidence": "high",
            "origin": "template",
            "data_as_of": latest_date,
            "source_currency": "real_time",
        })

    return claims


def claims_from_usaspending(
    results: list | None,
    *,
    prospect_org: str | None = None,
    prospect_name: str | None = None,
) -> list[dict]:
    """USAspending awards → claims.

    F4: when ``prospect_org`` or ``prospect_name`` is provided, drops
    records whose ``recipient_name`` doesn't match. Org match is tried
    first; falls through to person match if the org check fails."""
    if not results:
        return []
    claims = []
    for r in results[:MAX_CLAIMS]:
        recipient = r.get("recipient_name")
        amount = r.get("award_amount")
        agency = r.get("awarding_agency_name", "")
        start_date = r.get("period_of_performance_start_date", "")
        source_url = r.get("source_url", "")
        if not recipient or amount is None or not source_url:
            continue
        if prospect_org or prospect_name:
            matches = False
            if prospect_org and validate_org_name(prospect_org, str(recipient)):
                matches = True
            elif prospect_name and validate_person_name(prospect_name, str(recipient)):
                matches = True
            if not matches:
                continue
        amount_str = f"${amount:,.2f}" if isinstance(amount, (int, float)) else str(amount)
        claims.append({
            "text": f"{recipient} received {amount_str} from {agency} ({start_date})",
            "source_url": source_url,
            "confidence": "high",
            "origin": "template",
            "data_as_of": start_date or None,
            "source_currency": "quarterly",
        })
    return claims


def claims_from_opencorporates(
    officers: list | None,
    *,
    prospect_name: str | None = None,
) -> list[dict]:
    """OpenCorporates officers → claims.

    F4: when ``prospect_name`` is provided, drops records whose officer
    name doesn't pass ``validate_person_name``."""
    if not officers:
        return []
    claims = []
    for r in officers[:MAX_CLAIMS]:
        name = r.get("name")
        position = r.get("position")
        company = r.get("company_name")
        url = r.get("opencorporates_url", "")
        if not name or not position or not company or not url:
            continue
        if prospect_name and not validate_person_name(prospect_name, str(name)):
            continue
        claims.append({
            "text": f"{name} is recorded as {position} at {company} (OpenCorporates — verify current status)",
            "source_url": url,
            "confidence": "medium",
            "origin": "template",
            "data_as_of": None,
            "source_currency": "annual",
            "verified_current": False,
        })
    return claims


def claims_from_edgar_search(results: list | None) -> list[dict]:
    """EDGAR full-text search results → claims."""
    if not results:
        return []
    claims = []
    for r in results[:MAX_CLAIMS]:
        entity_name = r.get("entity_name")
        file_type = r.get("file_type")
        file_date = r.get("file_date", "")
        file_url = r.get("file_url", "")
        if not entity_name or not file_type or not file_url:
            continue
        claims.append({
            "text": f"{entity_name} filed {file_type} mentioning search term ({file_date})",
            "source_url": file_url,
            "confidence": "medium",
            "origin": "template",
            "data_as_of": file_date or None,
            "source_currency": "near_real_time",
        })
    return claims


def claims_from_wikipedia_infobox(wiki_data: dict | None) -> list[dict]:
    """Wikipedia infobox fields + board memberships → claims."""
    if not wiki_data:
        return []

    claims = []
    source_url = wiki_data.get("content_urls", "")
    if not source_url:
        title = wiki_data.get("title", "")
        source_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'), safe='')}" if title else ""

    if not source_url:
        return []

    infobox = wiki_data.get("infobox", {})
    title_name = wiki_data.get("title", "")

    _wiki_claim = {"source_url": source_url, "origin": "template", "data_as_of": None, "source_currency": "unknown"}

    # Current role from infobox — flag as unverified since Wikipedia currency is unknown
    role_title = infobox.get("title", "")
    role_org = infobox.get("organization", "") or infobox.get("employer", "")
    if role_title and role_org:
        claims.append({**_wiki_claim, "text": f"{title_name} serves as {role_title} at {role_org} (per Wikipedia — verify current status)", "confidence": "medium", "verified_current": False})
    elif role_title:
        claims.append({**_wiki_claim, "text": f"{title_name} holds the position of {role_title} (per Wikipedia — verify current status)", "confidence": "medium", "verified_current": False})

    # Education
    alma_mater = infobox.get("alma_mater", "") or infobox.get("education", "")
    if alma_mater:
        claims.append({**_wiki_claim, "text": f"{title_name} studied at {alma_mater}", "confidence": "high"})

    # Known for
    known_for = infobox.get("known_for", "")
    if known_for:
        claims.append({**_wiki_claim, "text": f"{title_name} is known for {known_for}", "confidence": "high"})

    # Net worth
    net_worth = infobox.get("net_worth", "")
    if net_worth:
        claims.append({**_wiki_claim, "text": f"{title_name} has an estimated net worth of {net_worth}", "confidence": "medium"})

    # Office (for political/public figures)
    office = infobox.get("office", "")
    if office:
        claims.append({**_wiki_claim, "text": f"{title_name} held the office of {office}", "confidence": "high"})

    # Board memberships from parsed article
    for bm in wiki_data.get("board_memberships", [])[:MAX_CLAIMS]:
        org = bm.get("organization", "")
        status = bm.get("temporal_status", "unknown")
        if not org:
            continue
        prefix = "serves" if status == "current" else "served" if status == "former" else "has served"
        is_current = status == "current"
        text = f"{title_name} {prefix} on the board of {org}"
        if is_current:
            text += " (per Wikipedia — verify current status)"
        claim = {
            **_wiki_claim,
            "text": text,
            "confidence": "high" if status == "former" else "medium",
            "temporal_status": status,
        }
        if is_current:
            claim["verified_current"] = False
        claims.append(claim)

    # Career history (notable positions only, first few)
    for pos in wiki_data.get("career_history", [])[:5]:
        pos_title = pos.get("title", "")
        pos_org = pos.get("organization", "")
        status = pos.get("temporal_status", "unknown")
        if not pos_title or not pos_org:
            continue
        prefix = "serves" if status == "current" else "served" if status == "former" else "has served"
        is_current = status == "current"
        text = f"{title_name} {prefix} as {pos_title} at {pos_org}"
        if is_current:
            text += " (per Wikipedia — verify current status)"
        claim = {
            **_wiki_claim,
            "text": text,
            "confidence": "high" if status == "former" else "medium",
            "temporal_status": status,
        }
        if is_current:
            claim["verified_current"] = False
        claims.append(claim)

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# Web search claims (Google Custom Search + Haiku extraction)
# ---------------------------------------------------------------------------

def claims_from_web_search(
    search_results: list[dict],
    person_name: str,
    client=None,
) -> list[dict]:
    """Extract structured claims from web search snippets using Haiku.

    If no LLM client is available, falls back to raw snippet claims.
    """
    if not search_results:
        return []

    claims = []

    if client is not None:
        # Build context from snippets
        snippet_text = "\n".join(
            f"[{r['title']}]({r['link']}): {r['snippet']}"
            for r in search_results[:10]
            if r.get("snippet")
        )
        if not snippet_text:
            return []

        try:
            result = client.complete(
                "web_search_extractor",
                f"Person: {person_name}\n\nWeb search results:\n{snippet_text}",
                (
                    "Extract factual claims about this person from web search results. "
                    "Focus on: current role/title, organization, board positions, "
                    "philanthropic activity, education, career history, notable achievements. "
                    "Each claim must include a source_url from the search result it came from. "
                    "Output JSON: {\"claims\": [{\"text\": \"...\", \"source_url\": \"https://...\", "
                    "\"confidence\": \"high|medium|low\"}]}. "
                    "Output valid JSON only, no markdown fences."
                ),
            )
            text = result.get("text", "")

            import json, re
            json_match = re.search(r"\{[^{}]*\"claims\"[^{}]*\[.*?\]\s*\}", text, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                for c in parsed.get("claims", []):
                    if c.get("text") and c.get("source_url"):
                        claims.append({
                            "text": c["text"],
                            "source_url": c["source_url"],
                            "confidence": c.get("confidence", "medium"),
                            "origin": "web_search",
                            "data_as_of": None,
                            "source_currency": "unknown",
                        })
        except Exception as e:
            import logging
            logging.getLogger("pebble.claim_templates").warning(
                "Web search Haiku extraction failed: %s", e
            )

    # Fallback: raw snippet claims if LLM failed or unavailable
    if not claims:
        for r in search_results[:5]:
            snippet = r.get("snippet", "").strip()
            link = r.get("link", "")
            if snippet and link and person_name.lower() in snippet.lower():
                claims.append({
                    "text": snippet,
                    "source_url": link,
                    "confidence": "medium",
                    "origin": "web_search",
                    "data_as_of": None,
                    "source_currency": "unknown",
                })

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# ProPublica 990 officer matching (person-level from org data)
# ---------------------------------------------------------------------------

def claims_from_propublica_officers(
    officers: list[dict],
    person_name: str,
    org_name: str = "",
    ein: str = "",
    tax_year: int | str | None = None,
) -> list[dict]:
    """Match a person's name against 990 officer list.

    Fuzzy-matches person_name against officer names from ProPublica 990 data.
    """
    if not officers or not person_name:
        return []

    claims = []
    name_parts = person_name.lower().split()
    source_url = f"https://projects.propublica.org/nonprofits/organizations/{ein}" if ein else ""
    year_str = str(tax_year) if tax_year else ""

    for officer in officers:
        officer_name = (officer.get("name") or "").lower()
        if not officer_name:
            continue
        # Fuzzy match: all parts of person_name must appear in officer_name
        if all(part in officer_name for part in name_parts):
            title = officer.get("title", "Officer")
            comp = officer.get("total_compensation")
            text = f"{person_name} was listed as {title} at {org_name}"
            if year_str:
                text += f" in the {year_str} Form 990"
            else:
                text += " (IRS Form 990)"
            if comp and float(comp) > 0:
                text += f" with compensation of ${float(comp):,.0f}"
            claims.append({
                "text": text,
                "source_url": source_url,
                "confidence": "high",
                "origin": "template",
                "data_as_of": year_str or None,
                "source_currency": "delayed",
            })

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# ProPublica 990 org officers — ALL officers (Sprint 4: org intelligence)
# ---------------------------------------------------------------------------

def claims_from_org_officers(
    officers: list[dict],
    org_name: str,
    ein: str = "",
    tax_year: int | str | None = None,
) -> list[dict]:
    """Generate claims for ALL officers at an organization.

    Unlike claims_from_propublica_officers (which fuzzy-matches a single
    person), this returns one claim per officer. Used by org intelligence
    to surface key people at connected organizations.
    """
    if not officers or not org_name:
        return []

    claims = []
    source_url = f"https://projects.propublica.org/nonprofits/organizations/{ein}" if ein else ""
    year_str = str(tax_year) if tax_year else ""

    for officer in officers:
        name = officer.get("name")
        if not name:
            continue

        title = officer.get("title") or "Officer"
        comp = officer.get("compensation") or 0

        text = f"{name} is {title} at {org_name}"
        if year_str:
            text += f" ({year_str} Form 990)"
        else:
            text += " (IRS Form 990)"
        if comp and float(comp) > 0:
            text += f", compensation ${float(comp):,.0f}"

        claims.append({
            "text": text,
            "source_url": source_url,
            "confidence": "high",
            "origin": "template",
            "data_as_of": year_str or None,
            "source_currency": "delayed",
        })

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# USAspending person affiliation (person context from org awards)
# ---------------------------------------------------------------------------

def claims_from_usaspending_person(
    usa_data: list,
    person_name: str,
    org_name: str = "",
) -> list[dict]:
    """Generate person-affiliation claims from USAspending org awards."""
    if not usa_data or not person_name or not org_name:
        return []

    claims = []
    org_lower = org_name.lower()

    for award in (usa_data or []):
        recipient = (award.get("recipient_name") or "").lower()
        if org_lower in recipient or recipient in org_lower:
            amount = award.get("award_amount")
            agency = award.get("awarding_agency_name", "")
            award_type = award.get("award_type", "award")
            url = award.get("url", "https://www.usaspending.gov")
            text = f"{person_name} is affiliated with {org_name}"
            if amount:
                text += f", which received a ${float(amount):,.0f} {award_type} from {agency}"
            start_date = award.get("period_of_performance_start_date", "")
            claims.append({
                "text": text,
                "source_url": url,
                "confidence": "medium",
                "origin": "template",
                "data_as_of": start_date or None,
                "source_currency": "quarterly",
            })

    return claims[:3]  # Limit to top 3 — these are inferred, not direct


# ---------------------------------------------------------------------------
# LDA lobbying data (lobbyist records + filing activity)
# ---------------------------------------------------------------------------

def claims_from_lobbying(
    lobbyists: list[dict] | None = None,
    filings: list[dict] | None = None,
    person_name: str = "",
) -> list[dict]:
    """LDA lobbying data -> claims about influence and networks."""
    claims = []

    # Lobbyist records (person is a registered lobbyist)
    if lobbyists and person_name:
        name_parts = person_name.lower().split()
        for lob in (lobbyists or [])[:5]:
            first = (lob.get("first_name") or "").lower()
            last = (lob.get("last_name") or "").lower()
            full = f"{first} {last}"
            if not all(part in full for part in name_parts):
                continue
            registrant = lob.get("registrant", {})
            reg_name = registrant.get("name", "")
            if reg_name:
                claims.append({
                    "text": f"{person_name} is a registered lobbyist at {reg_name}",
                    "source_url": "https://lda.senate.gov/",
                    "confidence": "high",
                    "origin": "template",
                    "data_as_of": None,
                    "source_currency": "quarterly",
                })

    # Filing records (org lobbying activity)
    if filings:
        for filing in (filings or [])[:5]:
            client = filing.get("client", {})
            client_name = client.get("name", "")
            registrant = filing.get("registrant", {})
            reg_name = registrant.get("name", "")
            year = filing.get("filing_year", "")
            income = filing.get("income")

            if not client_name or not reg_name:
                continue

            text = f"{reg_name} lobbied on behalf of {client_name}"
            if year:
                text += f" ({year})"
            if income and str(income).replace(".", "").isdigit() and float(income) > 0:
                text += f" — reported income ${float(income):,.0f}"

            # Get lobbying issues
            activities = filing.get("lobbying_activities", [])
            if activities:
                issues = [a.get("general_issue_code_display", "") for a in activities[:3] if a.get("general_issue_code_display")]
                if issues:
                    text += f" (issues: {', '.join(issues)})"

            source_url = filing.get("filing_document_url") or "https://lda.senate.gov/"
            claims.append({
                "text": text,
                "source_url": source_url,
                "confidence": "high",
                "origin": "template",
                "data_as_of": str(year) if year else None,
                "source_currency": "quarterly",
            })

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# ProPublica 990 org financials (org-level from filings_with_data)
# ---------------------------------------------------------------------------

def claims_from_org_financials(
    financials: dict | None,
    person_name: str = "",
) -> list[dict]:
    """Generate org-level financial claims from ProPublica 990 extract data.

    financials is the dict returned by propublica.extract_org_financials().
    """
    if not financials:
        return []

    org_name = financials.get("org_name", "")
    ein = financials.get("ein", "")
    tax_year = financials.get("tax_year")
    source_url = f"https://projects.propublica.org/nonprofits/organizations/{ein}" if ein else ""
    year_str = str(tax_year) if tax_year else ""

    if not org_name or not source_url:
        return []

    claims = []
    _base = {"source_url": source_url, "confidence": "high", "origin": "template", "data_as_of": year_str or None, "source_currency": "delayed"}

    # Revenue + assets
    revenue = financials.get("revenue")
    assets = financials.get("total_assets")
    if revenue is not None and assets is not None:
        claims.append({**_base, "text": f"{org_name} reported ${revenue:,.0f} in revenue and ${assets:,.0f} in total assets ({year_str} Form 990)"})
    elif revenue is not None:
        claims.append({**_base, "text": f"{org_name} reported ${revenue:,.0f} in revenue ({year_str} Form 990)"})

    # Contributions and grants received
    contributions = financials.get("contributions_and_grants")
    if contributions is not None and contributions > 0:
        claims.append({**_base, "text": f"{org_name} received ${contributions:,.0f} in contributions and grants ({year_str} Form 990)"})

    # Person affiliation context (if person is known to be at this org)
    officer_comp = financials.get("officer_compensation_total")
    if person_name and officer_comp is not None and officer_comp > 0:
        claims.append({**_base, "text": f"{org_name} paid ${officer_comp:,.0f} in total officer compensation ({year_str} Form 990)", "confidence": "medium"})

    return claims


# ---------------------------------------------------------------------------
# EDGAR Form 4 insider transactions
# ---------------------------------------------------------------------------

def claims_from_insider_transactions(filings: list[dict] | None) -> list[dict]:
    """EDGAR Form 4 filings → claims about insider trading activity (wealth signal)."""
    if not filings:
        return []

    claims = []
    for f in filings[:5]:
        entity = f.get("entity_name", "")
        file_date = f.get("file_date", "")
        file_url = f.get("file_url", "")
        description = f.get("file_description", "")

        if not entity or not file_url:
            continue

        text = f"{entity} filed Form 4 (insider transaction)"
        if description:
            text += f": {description}"
        if file_date:
            text += f" ({file_date})"

        claims.append({
            "text": text,
            "source_url": file_url,
            "confidence": "high",
            "origin": "template",
            "data_as_of": file_date or None,
            "source_currency": "near_real_time",
        })

    return claims


# ---------------------------------------------------------------------------
# FEC extended (committees, expenditures)
# ---------------------------------------------------------------------------

def claims_from_fec_committees(
    committees: list[dict] | None,
    person_name: str = "",
) -> list[dict]:
    """FEC committee data → claims about political involvement."""
    if not committees or not person_name:
        return []

    claims = []
    name_parts = person_name.lower().split()

    for comm in committees[:5]:
        treasurer = (comm.get("treasurer_name") or "").lower()
        comm_name = comm.get("name", "")
        comm_type = comm.get("committee_type_full", comm.get("committee_type", ""))
        party = comm.get("party_full", comm.get("party", ""))

        if not comm_name:
            continue

        # Check if person is treasurer
        if treasurer and all(part in treasurer for part in name_parts):
            text = f"{person_name} serves as treasurer of {comm_name}"
            if comm_type:
                text += f" ({comm_type})"
            claims.append({
                "text": text,
                "source_url": f"https://www.fec.gov/data/committee/{comm.get('committee_id', '')}/",
                "confidence": "high",
                "origin": "template",
                "data_as_of": None,
                "source_currency": "real_time",
                "verified_current": False,
            })

    return claims[:MAX_CLAIMS]


# ---------------------------------------------------------------------------
# Federal Register (government appointments and regulatory actions)
# ---------------------------------------------------------------------------

def claims_from_federal_register(
    documents: list[dict] | None,
    person_name: str = "",
) -> list[dict]:
    """Federal Register documents → claims about government appointments and influence."""
    if not documents:
        return []

    claims = []
    seen_titles = set()

    for doc in documents[:10]:
        title = doc.get("title", "")
        doc_type = doc.get("type", "")
        pub_date = doc.get("publication_date", "")
        html_url = doc.get("html_url", "")
        agencies = doc.get("agencies", [])

        if not title or not html_url or title in seen_titles:
            continue
        seen_titles.add(title)

        # Build agency context
        agency_names = [a.get("name", "") for a in agencies[:2] if a.get("name")]
        agency_str = f" ({', '.join(agency_names)})" if agency_names else ""

        # Determine claim text based on document type
        if doc_type == "Presidential Document":
            text = f"Presidential document: {title}{agency_str}"
        elif doc_type == "Notice":
            text = f"Federal notice: {title}{agency_str}"
        elif doc_type == "Rule":
            text = f"Federal rule: {title}{agency_str}"
        else:
            text = f"Federal Register: {title}{agency_str}"

        if pub_date:
            text += f" ({pub_date})"

        claims.append({
            "text": text,
            "source_url": html_url,
            "confidence": "medium",
            "origin": "template",
            "data_as_of": pub_date or None,
            "source_currency": "real_time",
        })

    return claims[:5]  # Limit — FR can return many tangential mentions


# ---------------------------------------------------------------------------
# FINRA BrokerCheck (broker/advisor registration and disclosures)
# ---------------------------------------------------------------------------

def claims_from_finra(
    individuals: list[dict] | None,
    person_name: str = "",
) -> list[dict]:
    """FINRA BrokerCheck data → claims about financial industry registration."""
    if not individuals or not person_name:
        return []

    claims = []
    name_parts = person_name.lower().split()

    for ind in individuals[:3]:
        first = (ind.get("ind_firstname") or "").lower()
        last = (ind.get("ind_lastname") or "").lower()
        full = f"{first} {last}"
        if not all(part in full for part in name_parts):
            continue

        display_name = f"{ind.get('ind_firstname', '')} {ind.get('ind_lastname', '')}".strip()
        bc_scope = ind.get("ind_bc_scope", "")
        ia_scope = ind.get("ind_ia_scope", "")

        # Registration status
        statuses = []
        if bc_scope == "Active":
            statuses.append("registered broker-dealer")
        if ia_scope == "Active":
            statuses.append("registered investment advisor")

        if statuses:
            # Current employers
            employers = ind.get("ind_current_employments", [])
            firm_names = [e.get("firm_name", "") for e in employers[:2] if e.get("firm_name")]

            text = f"{person_name} is a {' and '.join(statuses)}"
            if firm_names:
                text += f" at {', '.join(firm_names)}"
            text += " (FINRA BrokerCheck)"

            source_id = ind.get("ind_source_id", "")
            source_url = f"https://brokercheck.finra.org/individual/summary/{source_id}" if source_id else "https://brokercheck.finra.org/"

            claims.append({
                "text": text,
                "source_url": source_url,
                "confidence": "high",
                "origin": "template",
                "data_as_of": None,
                "source_currency": "real_time",
            })

        # Disclosure flag
        if ind.get("ind_bc_disclosure_fl") == "Y":
            source_id = ind.get("ind_source_id", "")
            claims.append({
                "text": f"{person_name} has disclosure events on their FINRA BrokerCheck record",
                "source_url": f"https://brokercheck.finra.org/individual/summary/{source_id}" if source_id else "https://brokercheck.finra.org/",
                "confidence": "high",
                "origin": "template",
                "data_as_of": None,
                "source_currency": "real_time",
            })

    return claims[:MAX_CLAIMS]
