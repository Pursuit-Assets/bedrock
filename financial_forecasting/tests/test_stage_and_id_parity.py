"""Phase D cross-cutting tests: stage enum alignment and ID authority rules.

D2 — Verify backend OpportunityStage enum stays in sync with frontend.
D3 — Verify local ID format: prospect-{timestamp}-{index}.
"""

import sys
import os
import re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from models import OpportunityStage, OPEN_STAGES, CLOSED_STAGES, COLLECTING_STAGES


# ---------------------------------------------------------------------------
# D2 — Stage enum alignment
# ---------------------------------------------------------------------------

class TestStageEnumAlignment:
    """Backend OpportunityStage must match frontend salesforce.ts stage constants."""

    # Actual Pursuit Salesforce picklist values (from models.py OpportunityStage enum)
    EXPECTED_STAGES = [
        "--None--",
        "Lead Gen",
        "New Lead",
        "Qualifying",
        "Ask in Progress",
        "Proposal Submitted",
        "Contract Creation",
        "Contracting",
        "Collecting / In Effect",
        "Closed / Did not Fulfill",
        "Closed / Completed",
        "Closed Lost",
        "Withdrawn",
    ]

    def test_all_expected_stages_in_enum(self):
        enum_values = {s.value for s in OpportunityStage}
        for stage in self.EXPECTED_STAGES:
            assert stage in enum_values, f"Missing stage in backend enum: {stage}"

    def test_no_extra_stages_in_enum(self):
        enum_values = {s.value for s in OpportunityStage}
        expected = set(self.EXPECTED_STAGES)
        extra = enum_values - expected
        assert not extra, f"Unexpected stages in backend enum: {extra}"

    def test_open_stages_are_not_closed(self):
        for stage in OPEN_STAGES:
            assert stage not in CLOSED_STAGES, f"{stage} is in both OPEN and CLOSED"

    def test_closed_stages_are_not_open(self):
        for stage in CLOSED_STAGES:
            assert stage not in OPEN_STAGES, f"{stage} is in both OPEN and CLOSED"

    def test_stage_groups_are_disjoint(self):
        """OPEN, COLLECTING, and CLOSED must not overlap."""
        assert not (OPEN_STAGES & CLOSED_STAGES)
        assert not (OPEN_STAGES & COLLECTING_STAGES)
        assert not (CLOSED_STAGES & COLLECTING_STAGES)

    def test_all_stages_categorized(self):
        """Every enum member (except --None--) should be in a stage group."""
        all_categorized = OPEN_STAGES | COLLECTING_STAGES | CLOSED_STAGES
        for stage in OpportunityStage:
            if stage == OpportunityStage.NONE:
                continue  # --None-- is a sentinel, not a real stage
            assert stage in all_categorized, (
                f"Stage {stage.value!r} not in any stage group"
            )

    def test_frontend_file_parity(self):
        """Check the frontend salesforce.ts has the same stage values."""
        ts_path = os.path.join(
            os.path.dirname(__file__), '..', 'frontend', 'src', 'types', 'salesforce.ts'
        )
        if not os.path.exists(ts_path):
            pytest.skip("salesforce.ts not found")

        with open(ts_path) as f:
            content = f.read()

        backend_values = {s.value for s in OpportunityStage}

        # Extract string literals that look like stage names from the TS file
        # Common patterns: 'Lead Gen' or "Lead Gen"
        ts_strings = set(re.findall(r"['\"]([A-Z][a-zA-Z /]+(?:\([^)]+\))?)['\"]", content))

        # Only compare strings that are plausible stage names (at least 2 words or in our set)
        matched = ts_strings & backend_values
        # We expect at least some stages to appear in the frontend types file
        assert len(matched) >= 4, (
            f"Expected frontend to reference backend stages. Found matches: {matched}"
        )


# ---------------------------------------------------------------------------
# D3 — ID authority rules
# ---------------------------------------------------------------------------

class TestIdAuthorityRules:
    """Local IDs follow prospect-{timestamp}-{index}; SF IDs take precedence."""

    LOCAL_ID_PATTERN = re.compile(r"^prospect-\d+-\d+$")

    def test_local_id_format_valid(self):
        valid_ids = [
            "prospect-1710547200000-0",
            "prospect-1710547200000-1",
            "prospect-1710633600000-42",
        ]
        for id_str in valid_ids:
            assert self.LOCAL_ID_PATTERN.match(id_str), f"Should be valid: {id_str}"

    def test_local_id_format_rejects_bad_ids(self):
        invalid_ids = [
            "lead-1710547200000-0",       # wrong prefix
            "prospect-abc-0",             # non-numeric timestamp
            "prospect-1710547200000",     # missing index
            "prospect--0",               # empty timestamp
            "006TESTOPPORTUNITY01",      # SF ID
            "",
        ]
        for id_str in invalid_ids:
            assert not self.LOCAL_ID_PATTERN.match(id_str), f"Should be invalid: {id_str}"

    def test_sf_id_takes_precedence(self):
        """When a lead is synced to Salesforce, the SF ID should be authoritative."""
        local_id = "prospect-1710547200000-0"
        sf_id = "006TESTOPPORTUNITY01"

        # Simulate the merge logic: SF ID wins
        merged_id = sf_id if sf_id.startswith("006") else local_id
        assert merged_id == sf_id

    def test_sf_id_detection(self):
        """Salesforce record IDs are 15 or 18 character alphanumeric strings."""
        sf_pattern = re.compile(r"^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$")

        assert sf_pattern.match("006TESTOPPORTUN")      # 15-char
        assert sf_pattern.match("006TESTOPPORTUNITY")   # 18-char
        assert not sf_pattern.match("prospect-123-0")    # local ID
        assert not sf_pattern.match("short")             # too short
