"""Tests for ``pebble/main.py:_validate_bedrock_bridge_config`` (Phase 0.6).

Refuses to start when production-shaped Pebble has misconfigured
service-to-service bridge to Bedrock. Failure modes silently routed
writes to ``http://localhost:8000`` without an internal key — Pebble
appeared to work but every write 401'd.

Invariants:

A. Dev / non-prod (no FRONTEND_URL https + no PEBBLE_ENV=production)
   never raises regardless of BEDROCK_API_URL / API key state.
B. Prod (FRONTEND_URL=https://...) requires BEDROCK_API_URL=https://...
C. Prod requires BEDROCK_INTERNAL_API_KEY non-empty.
D. PEBBLE_ENV=production overrides absent FRONTEND_URL — useful for
   headless cron deployments.
E. Whitespace-only API key counts as missing.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.main import _validate_bedrock_bridge_config


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("FRONTEND_URL", "PEBBLE_ENV", "BEDROCK_API_URL", "BEDROCK_INTERNAL_API_KEY"):
        monkeypatch.delenv(var, raising=False)


def test_dev_mode_no_frontend_url_does_not_raise():
    _validate_bedrock_bridge_config()  # no env at all


def test_dev_mode_localhost_frontend_does_not_raise(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")
    _validate_bedrock_bridge_config()


def test_dev_mode_misconfigured_bedrock_url_still_does_not_raise(monkeypatch):
    """In dev, even http://localhost:8000 is fine — that's the actual
    default for crm_bridge.py:14. The assertion is prod-only."""
    monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")
    monkeypatch.setenv("BEDROCK_API_URL", "http://localhost:8000")
    _validate_bedrock_bridge_config()


def test_prod_with_https_bedrock_and_key_does_not_raise(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "https://app.pursuit.org")
    monkeypatch.setenv("BEDROCK_API_URL", "https://api.pursuit.org")
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", "real-key-9d8s7f6g5h4j")
    _validate_bedrock_bridge_config()


def test_prod_missing_bedrock_url_raises(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "https://app.pursuit.org")
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", "real-key")
    with pytest.raises(RuntimeError, match=r"BEDROCK_API_URL must be set to an https"):
        _validate_bedrock_bridge_config()


@pytest.mark.parametrize("bad_url", [
    "http://api.pursuit.org",
    "http://localhost:8000",
    "ftp://api.pursuit.org",
    "api.pursuit.org",
    "",
])
def test_prod_non_https_bedrock_url_raises(monkeypatch, bad_url):
    monkeypatch.setenv("FRONTEND_URL", "https://app.pursuit.org")
    monkeypatch.setenv("BEDROCK_API_URL", bad_url)
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", "real-key")
    with pytest.raises(RuntimeError, match=r"https"):
        _validate_bedrock_bridge_config()


def test_prod_missing_internal_api_key_raises(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "https://app.pursuit.org")
    monkeypatch.setenv("BEDROCK_API_URL", "https://api.pursuit.org")
    with pytest.raises(RuntimeError, match=r"BEDROCK_INTERNAL_API_KEY must be set"):
        _validate_bedrock_bridge_config()


@pytest.mark.parametrize("blank_key", ["", "   ", "\t", "\n"])
def test_prod_blank_internal_api_key_raises(monkeypatch, blank_key):
    """Whitespace-only API key counts as missing — same as empty."""
    monkeypatch.setenv("FRONTEND_URL", "https://app.pursuit.org")
    monkeypatch.setenv("BEDROCK_API_URL", "https://api.pursuit.org")
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", blank_key)
    with pytest.raises(RuntimeError, match=r"BEDROCK_INTERNAL_API_KEY must be set"):
        _validate_bedrock_bridge_config()


def test_pebble_env_production_override_no_frontend_url(monkeypatch):
    """PEBBLE_ENV=production triggers the prod path even without
    FRONTEND_URL. Headless cron deployments don't have a frontend URL.
    """
    monkeypatch.setenv("PEBBLE_ENV", "production")
    monkeypatch.setenv("BEDROCK_API_URL", "http://localhost:8000")
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", "real-key")
    with pytest.raises(RuntimeError, match=r"https"):
        _validate_bedrock_bridge_config()


def test_pebble_env_production_case_insensitive(monkeypatch):
    monkeypatch.setenv("PEBBLE_ENV", "PRODUCTION")
    monkeypatch.setenv("BEDROCK_API_URL", "http://localhost:8000")
    monkeypatch.setenv("BEDROCK_INTERNAL_API_KEY", "real-key")
    with pytest.raises(RuntimeError):
        _validate_bedrock_bridge_config()


def test_pebble_env_other_values_treated_as_dev(monkeypatch):
    """PEBBLE_ENV=staging / development / arbitrary → dev-mode path."""
    for value in ("staging", "development", "test", "dev", ""):
        monkeypatch.setenv("PEBBLE_ENV", value)
        # Misconfigured bridge — but we're not in prod, so no raise.
        monkeypatch.setenv("BEDROCK_API_URL", "http://localhost:8000")
        monkeypatch.delenv("BEDROCK_INTERNAL_API_KEY", raising=False)
        _validate_bedrock_bridge_config()
