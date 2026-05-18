"""ModelClient: hybrid router — OpenRouter free models for workers, Anthropic direct for queens."""

import logging
import os
from dataclasses import dataclass
from enum import Enum

from anthropic import Anthropic

logger = logging.getLogger("pebble.model_client")


class ModelTier(Enum):
    WORKER = "worker"
    DRONE = "drone"
    FORAGER = "forager"
    QUEEN = "queen"


@dataclass
class ModelConfig:
    tier: ModelTier
    model_id: str
    temperature: float
    max_tokens: int
    cost_per_mtok_input: float
    cost_per_mtok_output: float


TIER_CONFIGS = {
    ModelTier.WORKER: ModelConfig(
        tier=ModelTier.WORKER,
        model_id="claude-haiku-4-5-20251001",
        temperature=0.0,
        max_tokens=2000,
        cost_per_mtok_input=1.0,
        cost_per_mtok_output=5.0,
    ),
    ModelTier.DRONE: ModelConfig(
        tier=ModelTier.DRONE,
        model_id="claude-haiku-4-5-20251001",
        temperature=0.0,
        max_tokens=2000,
        cost_per_mtok_input=1.0,
        cost_per_mtok_output=5.0,
    ),
    ModelTier.FORAGER: ModelConfig(
        tier=ModelTier.FORAGER,
        model_id="claude-sonnet-4-6",
        temperature=0.2,
        max_tokens=4000,
        cost_per_mtok_input=3.0,
        cost_per_mtok_output=15.0,
    ),
    ModelTier.QUEEN: ModelConfig(
        tier=ModelTier.QUEEN,
        model_id="claude-opus-4-6",
        temperature=0.0,
        max_tokens=6000,
        cost_per_mtok_input=15.0,
        cost_per_mtok_output=75.0,
    ),
}

AGENT_TIERS = {
    "api_response_extractor": ModelTier.WORKER,
    "batch_summarizer": ModelTier.DRONE,
    "philanthropy_agent": ModelTier.FORAGER,
    "wealth_indicator_agent": ModelTier.FORAGER,
    "entity_resolution_agent": ModelTier.FORAGER,
    "verifier_source": ModelTier.WORKER,
    "verifier_consistency": ModelTier.WORKER,
    "verifier_crossref": ModelTier.WORKER,
    "claim_verifier_singleclaim": ModelTier.WORKER,
    "fact_check_agent": ModelTier.QUEEN,
    "profile_synthesizer": ModelTier.QUEEN,
    # Ask Pebble chat agents
    "query_classifier": ModelTier.WORKER,
    "l1_synthesizer": ModelTier.WORKER,
    "crm_agent": ModelTier.WORKER,
    "t1_identity_assessor": ModelTier.WORKER,
    "t2_structured_synthesizer": ModelTier.FORAGER,
    "web_search_extractor": ModelTier.WORKER,
}

# OpenRouter free model fallback chain for worker/drone tiers
FREE_MODEL_CHAIN = [
    "nvidia/nemotron-3-super-120b-a12b:free",  # Primary: 120B MoE, structured output
    "openrouter/free",                           # Backup: auto-route to any free model
]

OPENROUTER_TIERS = {ModelTier.WORKER, ModelTier.DRONE}


def get_model_config(agent_name: str) -> ModelConfig:
    tier = AGENT_TIERS.get(agent_name)
    if tier is None:
        raise ValueError(f"Unknown agent: {agent_name}. Valid: {list(AGENT_TIERS.keys())}")
    config = TIER_CONFIGS.get(tier)
    if config is None:
        raise ValueError(f"No config for tier: {tier}")
    return config


def get_model_config_by_tier(tier: ModelTier) -> ModelConfig:
    config = TIER_CONFIGS.get(tier)
    if config is None:
        raise ValueError(f"No config for tier: {tier}")
    return config


# Escalation chain: worker → forager (skip drone, same model)
ESCALATION_CHAIN = {
    ModelTier.WORKER: ModelTier.FORAGER,
    ModelTier.DRONE: ModelTier.FORAGER,
}


class ModelClient:
    """Hybrid router: OpenRouter free models for workers, Anthropic direct for queens."""

    def __init__(self):
        self._client = Anthropic()
        # Four-field token usage to capture Anthropic's prompt-caching fields.
        # cache_create tokens are billed at 1.25x normal input rate;
        # cache_read tokens are billed at 0.10x — a 10x cost cut. The
        # _last_usage shape is read by harness.py and persisted to
        # bedrock.pebble_harness_log (extended in
        # 2026-05-18-pebble-ledger-instrumentation.sql).
        self._last_usage = {"input": 0, "output": 0, "cache_create": 0, "cache_read": 0}
        self._last_provider = "anthropic"

        # Initialize OpenRouter client if key is available
        or_key = os.getenv("OPENROUTER_API_KEY")
        self._openrouter = None
        if or_key:
            try:
                from openai import OpenAI
                self._openrouter = OpenAI(
                    base_url="https://openrouter.ai/api/v1",
                    api_key=or_key,
                )
                logger.info("OpenRouter client initialized")
            except ImportError:
                logger.warning("openai package not installed — OpenRouter disabled")

    def complete(self, agent_name: str, prompt: str, system: str = "") -> dict:
        config = get_model_config(agent_name)
        tier = AGENT_TIERS[agent_name]

        # Try OpenRouter free chain for worker/drone tiers
        if self._openrouter and tier in OPENROUTER_TIERS:
            for model_id in FREE_MODEL_CHAIN:
                try:
                    result = self._complete_openrouter(model_id, prompt, system, config, agent_name)
                    return result
                except Exception as e:
                    logger.warning("OpenRouter %s failed for %s: %s", model_id, agent_name, e)
            # All free models failed — fall through to Anthropic
            logger.info("All OpenRouter models failed for %s, falling back to Anthropic", agent_name)

        # Fallback: Anthropic direct (always works)
        return self._complete_anthropic(agent_name, prompt, system, config)

    def complete_with_tier(self, tier: ModelTier, prompt: str, system: str = "", agent_name: str = "") -> dict:
        """Complete using a specific tier (for escalation). Anthropic only."""
        config = get_model_config_by_tier(tier)
        return self._complete_anthropic(agent_name or "escalated", prompt, system, config)

    def complete_with_tools(
        self,
        agent_name: str,
        messages: list[dict],
        system: str = "",
        tools: list[dict] | None = None,
    ) -> dict:
        """Complete with tool-use support. Anthropic direct only.

        Unlike complete(), this accepts a full messages array (for multi-turn
        tool-use conversations) and passes tools to the API.

        Returns:
            {
                "message": {"role": "assistant", "content": [...]},
                "stop_reason": "end_turn" | "tool_use",
                "usage": {"input": int, "output": int},
            }
        """
        config = get_model_config(agent_name)

        kwargs: dict = {
            "model": config.model_id,
            "max_tokens": config.max_tokens,
            "messages": messages,
            "temperature": config.temperature,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools

        message = self._client.messages.create(**kwargs)

        self._last_usage = {
            "input": message.usage.input_tokens,
            "output": message.usage.output_tokens,
            "cache_create": getattr(message.usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read": getattr(message.usage, "cache_read_input_tokens", 0) or 0,
        }
        self._last_provider = f"anthropic/{config.model_id}"

        # Serialize content blocks to plain dicts (SDK returns typed objects)
        content_dicts = []
        for block in message.content:
            if block.type == "text":
                content_dicts.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                content_dicts.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })

        logger.info(
            "Anthropic %s handled %s with tools (%d in, %d out tokens)",
            config.model_id, agent_name,
            self._last_usage["input"], self._last_usage["output"],
        )

        return {
            "message": {"role": "assistant", "content": content_dicts},
            "stop_reason": message.stop_reason,
            "usage": self._last_usage.copy(),
        }

    def _complete_openrouter(self, model_id: str, prompt: str, system: str, config: ModelConfig, agent_name: str) -> dict:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        response = self._openrouter.chat.completions.create(
            model=model_id,
            messages=messages,
            max_tokens=config.max_tokens,
            temperature=config.temperature,
            extra_headers={
                "HTTP-Referer": "https://pursuit.org",
                "X-Title": "Pebble Research Pipeline",
            },
        )
        text = response.choices[0].message.content or ""
        # OpenAI-compatible usage object doesn't expose cache fields; we leave
        # cache_create/cache_read at 0. calculate_cost() short-circuits to $0
        # for OpenRouter anyway since these are the free tier.
        usage = {
            "input": response.usage.prompt_tokens if response.usage else 0,
            "output": response.usage.completion_tokens if response.usage else 0,
            "cache_create": 0,
            "cache_read": 0,
        }
        self._last_usage = usage
        self._last_provider = f"openrouter/{model_id}"
        logger.info("OpenRouter %s handled %s (%d in, %d out tokens)",
                     model_id, agent_name, usage["input"], usage["output"])
        return {"text": text, "content": text, "usage": usage}

    def _complete_anthropic(self, agent_name: str, prompt: str, system: str | list, config: ModelConfig) -> dict:
        # system may be a string (legacy callers) or a list of content blocks
        # (cache-aware callers passing cache_control:ephemeral markers). The
        # Anthropic SDK accepts either form on the system param. Promote bare
        # strings to a single text block so cache-marked callers can opt in
        # without affecting every existing call site.
        kwargs: dict = {
            "model": config.model_id,
            "max_tokens": config.max_tokens,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": config.temperature,
        }
        if system:
            kwargs["system"] = system
        message = self._client.messages.create(**kwargs)
        self._last_usage = {
            "input": message.usage.input_tokens,
            "output": message.usage.output_tokens,
            "cache_create": getattr(message.usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read": getattr(message.usage, "cache_read_input_tokens", 0) or 0,
        }
        self._last_provider = f"anthropic/{config.model_id}"
        text = message.content[0].text if message.content else ""
        # Cache breakdown surfaces in the harness log + cockpit cache-hit chip.
        if self._last_usage["cache_create"] or self._last_usage["cache_read"]:
            logger.info(
                "Anthropic %s handled %s (%d in / %d out / %d cache_create / %d cache_read)",
                config.model_id, agent_name,
                self._last_usage["input"], self._last_usage["output"],
                self._last_usage["cache_create"], self._last_usage["cache_read"],
            )
        else:
            logger.info("Anthropic %s handled %s (%d in, %d out tokens)",
                         config.model_id, agent_name, self._last_usage["input"], self._last_usage["output"])
        return {"text": text, "content": text, "usage": self._last_usage}

    def get_last_token_count(self) -> dict:
        return self._last_usage.copy()

    def get_last_provider(self) -> str:
        return self._last_provider

    def calculate_cost(self, agent_name: str, tokens: dict) -> float:
        """Compute USD cost from a four-field tokens dict.

        Delegates to ``pebble.llm.cost.calculate_cost_usd`` — the canonical
        pricing path shared with the L1 Anthropic client. Keeping the math
        in one place prevents drift when Anthropic ships price changes.

        Anthropic's prompt-caching billing (per ``pebble/llm/cost.py``):
          - cache_create tokens: 1.25× input rate
          - cache_read tokens:   0.10× input rate
          - regular input + output: configured per-Mtok rates

        For OpenRouter free-tier calls we short-circuit to $0; OpenAI-
        compatible usage objects don't expose cache fields anyway.

        ``tokens`` dict accepts both the legacy two-field shape
        ({"input", "output"}) and the new four-field shape
        ({"input", "output", "cache_create", "cache_read"}). Missing
        cache fields default to 0 so old call sites keep working.
        """
        if "openrouter" in self._last_provider:
            return 0.0
        from .llm.cost import calculate_cost_usd
        config = get_model_config(agent_name)
        return calculate_cost_usd(
            model=config.model_id,
            input_tokens=tokens.get("input", 0),
            output_tokens=tokens.get("output", 0),
            cache_creation_input_tokens=tokens.get("cache_create", 0),
            cache_read_input_tokens=tokens.get("cache_read", 0),
        )

    def estimate_cost(self, agent_name: str, input_tokens: float, output_tokens: float) -> float:
        config = get_model_config(agent_name)
        return (
            (input_tokens / 1_000_000) * config.cost_per_mtok_input
            + (output_tokens / 1_000_000) * config.cost_per_mtok_output
        )
