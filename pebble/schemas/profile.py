"""Profile and claim schemas. Every claim must have source_url (CLAUDE.md Rule 9)."""

from pydantic import BaseModel, Field


class Claim(BaseModel):
    """A single claim with required source URL."""

    text: str
    source_url: str = Field(..., description="Required. Every claim must have a source URL.")
    confidence: str = Field(default="medium", pattern="^(high|medium|low)$")
    temporal_status: str = Field(default="unknown", pattern="^(current|former|unknown)$")
    data_as_of: str | None = Field(default=None, description="ISO date/year the data reflects, e.g. '2024-03-15' or '2023'")
    source_currency: str = Field(
        default="unknown",
        pattern="^(real_time|near_real_time|quarterly|annual|delayed|unknown)$",
        description="How current the data source typically is",
    )


class Profile(BaseModel):
    """Research profile for a prospect."""

    claims: list[Claim] = Field(default_factory=list)
    summary: str = ""
    confidence_score: str = Field(default="medium", pattern="^(high|medium|low)$")
    partial: bool = Field(default=False, description="True if some agents failed")
    failed_agents: list[str] = Field(default_factory=list)


class ProspectInput(BaseModel):
    """Minimal prospect for research request."""

    id: str
    first_name: str = ""
    last_name: str = ""
    organization: str = ""
    ein: str | None = None
    organizations: list[str] | None = None  # Multiple affiliations; Pebble fetches 990/SEC for each


class ResearchRequest(BaseModel):
    """Request body for POST /api/v1/research/request."""

    contact_ids: list[str] = Field(..., min_length=1)
    prospects: list[ProspectInput] | None = None  # Optional; if not provided, use contact_ids as stub IDs
    job_id: str | None = None  # Client-generated UUID for cancellation support


class CancelRequest(BaseModel):
    """Request body for POST /api/v1/research/cancel."""

    job_id: str


class TieredResearchRequest(BaseModel):
    """Request body for POST /api/v1/research/tiered — single-prospect tiered research."""

    first_name: str = ""
    last_name: str = ""
    organization: str = ""
    contact_id: str | None = None
    tier: int = Field(1, ge=1, le=3)


class ResearchFeedback(BaseModel):
    """Request body for POST /api/v1/research/feedback."""

    claim_id: str
    correct: bool
    text: str | None = None
    contact_id: str | None = None
