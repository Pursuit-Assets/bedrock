"""Tests for source_governance.py.

Pure unit tests — no DB, no mocks needed. Validates the canonical enum,
the visibility rule, and the validate_source helper.
"""

import pytest

from source_governance import (
    ALL_SOURCES,
    BUILDER_VISIBLE_SOURCES,
    STAFF_ONLY_SOURCES,
    ContactSource,
    is_builder_visible,
    is_staff_only,
    validate_source,
)


# ---------------------------------------------------------------------------
# Enum integrity
# ---------------------------------------------------------------------------


class TestEnumIntegrity:
    def test_builder_visible_sources_match_enum(self):
        """Every value in BUILDER_VISIBLE_SOURCES must be a real ContactSource."""
        for src in BUILDER_VISIBLE_SOURCES:
            # Will raise ValueError if not a valid enum value
            ContactSource(src)

    def test_staff_only_sources_match_enum(self):
        """Every value in STAFF_ONLY_SOURCES must be a real ContactSource."""
        for src in STAFF_ONLY_SOURCES:
            ContactSource(src)

    def test_no_overlap(self):
        """A source can't be both Builder-visible AND staff-only."""
        assert BUILDER_VISIBLE_SOURCES.isdisjoint(STAFF_ONLY_SOURCES)

    def test_all_sources_complete(self):
        """Every ContactSource value must appear in either set (no orphans)."""
        all_enum_values = {s.value for s in ContactSource}
        assert all_enum_values == ALL_SOURCES, (
            f"Orphaned enum values: {all_enum_values - ALL_SOURCES}"
        )

    def test_all_sources_is_union(self):
        """ALL_SOURCES must equal the union of the two role sets."""
        assert ALL_SOURCES == BUILDER_VISIBLE_SOURCES | STAFF_ONLY_SOURCES


# ---------------------------------------------------------------------------
# is_builder_visible / is_staff_only
# ---------------------------------------------------------------------------


class TestIsBuilderVisible:
    @pytest.mark.parametrize("source", sorted(BUILDER_VISIBLE_SOURCES))
    def test_each_builder_visible_source(self, source):
        assert is_builder_visible(source) is True
        assert is_staff_only(source) is False

    @pytest.mark.parametrize("source", sorted(STAFF_ONLY_SOURCES))
    def test_each_staff_only_source(self, source):
        assert is_builder_visible(source) is False
        assert is_staff_only(source) is True

    def test_none_returns_false(self):
        """NULL source must default to staff-only (conservative deny)."""
        assert is_builder_visible(None) is False
        assert is_staff_only(None) is True

    def test_unknown_string_returns_false(self):
        """Typos and unknown values must default to staff-only."""
        assert is_builder_visible("unknown_source") is False
        assert is_builder_visible("LINKEDIN_IMPORT") is False  # case-sensitive
        assert is_builder_visible("") is False
        assert is_staff_only("unknown_source") is True


# ---------------------------------------------------------------------------
# validate_source
# ---------------------------------------------------------------------------


class TestValidateSource:
    @pytest.mark.parametrize("source", sorted(ALL_SOURCES))
    def test_accepts_canonical_values(self, source):
        """Every value in ALL_SOURCES must pass validation."""
        assert validate_source(source) == source

    def test_rejects_unknown(self):
        """Unknown values must raise ValueError."""
        with pytest.raises(ValueError) as exc_info:
            validate_source("not_a_real_source")
        assert "Invalid contact source" in str(exc_info.value)
        assert "not_a_real_source" in str(exc_info.value)

    def test_rejects_typo(self):
        """Common typos like wrong case or trailing space must be rejected."""
        with pytest.raises(ValueError):
            validate_source("LINKEDIN_IMPORT")  # wrong case
        with pytest.raises(ValueError):
            validate_source("linkedin_import ")  # trailing space
        with pytest.raises(ValueError):
            validate_source("")  # empty string

    def test_returns_input_unchanged(self):
        """validate_source returns the input value for chaining."""
        result = validate_source(ContactSource.LINKEDIN_IMPORT.value)
        assert result == "linkedin_import"
        assert isinstance(result, str)
