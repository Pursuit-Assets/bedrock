"""Canonical contact/company source governance.

Single source of truth for "where did this record come from?" and the
visibility rule that follows from it. Used by Bedrock-side code that creates
or queries contact/account records to ensure provenance is tracked
consistently and that records originating from staff-only sources never
leak into Builder-facing views.

Mirrors the CHECK constraints in db/init.sql for prospect_sf_* tables and
the proposed CHECK constraint for public.contacts.source /
public.companies.source (see docs/contact-source-governance.md for the
platform team coordination ask).

The canonical enum is the contract between Bedrock and the platform team.
Adding a value here also requires:
  1. Updating the CHECK constraints in db/init.sql for prospect_sf_*
  2. Updating docs/contact-source-governance.md
  3. Coordinating with the platform team if the new value affects public.*
"""

from enum import Enum
from typing import Optional


class ContactSource(str, Enum):
    """Canonical enum of contact/company source values.

    Builder-visible (existing platform values, do not rename):
    """
    LINKEDIN_IMPORT = "linkedin_import"
    CLEARBIT = "clearbit"
    MANUAL = "manual"
    SPUTNIK = "sputnik"
    PLATFORM_USER_ADDED = "platform_user_added"

    # Staff-only (new Bedrock values)
    SALESFORCE = "salesforce"
    PEBBLE_RESEARCH = "pebble_research"
    BEDROCK_PROSPECT_IMPORT = "bedrock_prospect_import"
    MANUAL_STAFF = "manual_staff"


# Builder-visible: records with these sources may be shown to Builders.
# These are mostly the platform's existing source values (verified against
# segundo-db: linkedin_import has 16,646 contact rows + 9,743 company rows;
# clearbit has 1,378 company rows; manual has 306 company rows).
BUILDER_VISIBLE_SOURCES = frozenset([
    ContactSource.LINKEDIN_IMPORT.value,
    ContactSource.CLEARBIT.value,
    ContactSource.MANUAL.value,
    ContactSource.SPUTNIK.value,
    ContactSource.PLATFORM_USER_ADDED.value,
])

# Staff-only: records with these sources MUST NOT be shown to Builders.
# These are all Bedrock-originated populations: SF donor pipeline, Pebble
# prospect research (HNWI lookup), CSV imports of VIP lists, manual entries
# made via Bedrock by staff.
STAFF_ONLY_SOURCES = frozenset([
    ContactSource.SALESFORCE.value,
    ContactSource.PEBBLE_RESEARCH.value,
    ContactSource.BEDROCK_PROSPECT_IMPORT.value,
    ContactSource.MANUAL_STAFF.value,
])

# Union of all canonical values — used by validate_source() and the CHECK
# constraints in db/init.sql.
ALL_SOURCES = BUILDER_VISIBLE_SOURCES | STAFF_ONLY_SOURCES


def is_builder_visible(source: Optional[str]) -> bool:
    """Return True iff a record with this source should be visible to Builders.

    Conservative default: NULL or unknown source → False (staff only).
    Existing platform rows are all tagged (verified — no NULLs in either
    public.contacts or public.companies as of 2026-04-08), so this default
    only affects future malformed data.
    """
    if source is None:
        return False
    return source in BUILDER_VISIBLE_SOURCES


def is_staff_only(source: Optional[str]) -> bool:
    """Return True iff a record with this source must NOT be shown to Builders.

    NULL or unknown source → True (conservative deny).
    """
    return not is_builder_visible(source)


def validate_source(source: str) -> str:
    """Raise ValueError if `source` is not in the canonical enum.

    Used at write boundaries (API ingest, prospect_import write paths,
    Pebble tier handlers) to catch typos before they hit the DB CHECK
    constraint and produce a less-helpful error.

    Returns the input value unchanged so callers can chain:
        contact_data["source"] = validate_source(user_supplied_source)
    """
    if source not in ALL_SOURCES:
        raise ValueError(
            f"Invalid contact source {source!r}. Must be one of: {sorted(ALL_SOURCES)}"
        )
    return source
