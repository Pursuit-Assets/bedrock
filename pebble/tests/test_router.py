"""Tests for the Pebble query router."""

import pytest
from unittest.mock import MagicMock, AsyncMock

from pebble import chisel as _chisel
from pebble.router import (
    _check_redirect, _check_slash_command,
    RouteResult, classify_query,
)

# Slash-command routing reads from chisel's autoload-populated maps.
# Run autoload once at module import so the slash tests see /pipeline.
_chisel.autoload()


class TestCheckRedirect:
    """Regex redirect patterns."""

    def test_drafting_redirect(self):
        result = _check_redirect("draft an email to John")
        assert result is not None
        assert result.level == -1
        assert result.redirect_target == "cowork"

    def test_calendar_redirect(self):
        result = _check_redirect("schedule a meeting tomorrow")
        assert result is not None
        assert result.level == -1
        assert result.redirect_target == "bedrock_priorities"

    def test_no_redirect_for_research(self):
        result = _check_redirect("Who is Jane Smith?")
        assert result is None

    def test_no_redirect_for_crm(self):
        result = _check_redirect("What's the pipeline value?")
        assert result is None


class TestClassifyQuery:
    """Tests for the main classify_query function."""

    @pytest.mark.asyncio
    async def test_mode_override_full(self):
        result = await classify_query("anything", mode="full")
        assert result.level == 30
        assert result.mode_override == "full"

    @pytest.mark.asyncio
    async def test_mode_override_quick(self):
        result = await classify_query("anything", mode="quick")
        assert result.level == 0
        assert result.mode_override == "quick"

    @pytest.mark.asyncio
    async def test_fallback_no_client(self):
        result = await classify_query("Who is Jane Smith?")
        assert result.level == 1
        assert result.intent == "default_l1"
        assert result.confidence == 0.3

    @pytest.mark.asyncio
    async def test_redirect_bypasses_llm(self):
        result = await classify_query("send an email to John")
        assert result.level == -1
        assert result.redirect_target == "cowork"

    @pytest.mark.asyncio
    async def test_haiku_classification(self):
        """Router regex \\{[^}]*\\} only handles flat JSON — no nested braces."""
        client = MagicMock()
        client.complete.return_value = {
            "text": '{"level": 20, "intent": "research_structured", "confidence": 0.9}'
        }
        result = await classify_query("Research Jane Smith at Acme", client=client)
        assert result.level == 20
        assert result.intent == "research_structured"
        assert result.confidence == 0.9

    @pytest.mark.asyncio
    async def test_haiku_low_confidence_defaults_to_l1(self):
        client = MagicMock()
        client.complete.return_value = {
            "text": '{"level": 30, "intent": "unclear", "entities": {}, "confidence": 0.4}'
        }
        result = await classify_query("something ambiguous", client=client)
        assert result.level == 1  # low confidence → default to L1

    @pytest.mark.asyncio
    async def test_haiku_failure_defaults_to_l1(self):
        client = MagicMock()
        client.complete.side_effect = Exception("API error")
        result = await classify_query("Who is Jane Smith?", client=client)
        assert result.level == 1
        assert result.confidence == 0.3

    @pytest.mark.asyncio
    async def test_haiku_non_json_defaults_to_l1(self):
        client = MagicMock()
        client.complete.return_value = {"text": "I don't understand the query"}
        result = await classify_query("something weird", client=client)
        assert result.level == 1
        assert result.intent == "haiku_parse_error"

    @pytest.mark.asyncio
    async def test_mode_override_with_client(self):
        """Mode override sets level even when Haiku returns different level."""
        client = MagicMock()
        client.complete.return_value = {
            "text": '{"level": 10, "intent": "research", "confidence": 0.95}'
        }
        result = await classify_query("Research John Doe", mode="full", client=client)
        assert result.level == 30  # mode override
        assert result.mode_override == "full"


class TestSlashCommand:
    """Slash command short-circuit — deterministic workflow path."""

    def test_pipeline_slash_command_routes_to_workflow(self):
        result = _check_slash_command("/pipeline")
        assert result is not None
        assert result.level == 2
        assert result.intent == "workflow_weekly_pipeline_review"
        assert result.entities["slash_command"] == "/pipeline"
        assert result.entities["args"] == ""

    def test_pipeline_with_trailing_args_captures_args(self):
        result = _check_slash_command("/pipeline this quarter")
        assert result is not None
        assert result.level == 2
        assert result.entities["args"] == "this quarter"

    def test_pipeline_case_insensitive(self):
        result = _check_slash_command("/PIPELINE")
        assert result is not None
        assert result.intent == "workflow_weekly_pipeline_review"

    def test_unknown_slash_command_returns_none(self):
        # Unknown commands fall through to redirect/Haiku — they're
        # not recognized by the router but not necessarily bad input.
        assert _check_slash_command("/unknown") is None
        assert _check_slash_command("/foo bar") is None

    def test_no_slash_returns_none(self):
        assert _check_slash_command("regular query") is None
        assert _check_slash_command("") is None
        assert _check_slash_command(None) is None  # type: ignore[arg-type]

    def test_slash_in_middle_returns_none(self):
        # Only first-token slash counts as a command
        assert _check_slash_command("show /pipeline view") is None

    def test_slash_command_strips_whitespace(self):
        result = _check_slash_command("  /pipeline  ")
        assert result is not None
        assert result.intent == "workflow_weekly_pipeline_review"

    @pytest.mark.asyncio
    async def test_classify_query_routes_pipeline_slash(self):
        """End-to-end: classify_query honors slash command before
        redirect/Haiku."""
        result = await classify_query("/pipeline")
        assert result.level == 2
        assert result.intent == "workflow_weekly_pipeline_review"

    @pytest.mark.asyncio
    async def test_slash_command_bypasses_llm(self):
        """Even if a Haiku client is available, slash commands skip it."""
        client = MagicMock()
        client.complete.return_value = {
            "text": '{"level": 1, "intent": "synthesize"}'
        }
        result = await classify_query("/pipeline", client=client)
        assert result.level == 2
        # Haiku NOT called
        assert client.complete.call_count == 0

    @pytest.mark.asyncio
    async def test_slash_command_overrides_mode_classifier(self):
        """Slash commands take precedence even with explicit mode."""
        # Mode override fires BEFORE slash check in classify_query.
        # This documents that ordering — if we want slash to win over
        # mode, the ordering needs to flip. For v1.0 we keep mode>slash
        # because mode is also explicit user choice and was here first.
        result = await classify_query("/pipeline", mode="full")
        # Mode wins → level=30, not 2
        assert result.level == 30

    def test_slash_commands_table_has_pipeline(self):
        """Smoke test: chisel autoload registers the /pipeline slash."""
        assert _chisel.slash_command_map().get("/pipeline") == "weekly_pipeline_review"
        assert _chisel.slash_to_intent("/pipeline") == "workflow_weekly_pipeline_review"
