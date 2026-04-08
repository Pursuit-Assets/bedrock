"""Tests for env_validator.py.

Follows the patch.dict(os.environ, ..., clear=True) pattern from
tests/test_mcp_services.py:171. clear=True wipes the real shell env
so tests aren't accidentally satisfied by the developer's actual .env values.
"""

import logging
import os
from unittest.mock import patch

import pytest

# sys.path is set up by conftest.py, so this works
from env_validator import (
    Environment,
    REQUIRED_VARS,
    current_environment,
    validate_jwt_secret_strength,
    validate_required_env,
)


# A 32-char-long string that satisfies the strength check, used as a known-good
# JWT secret across the prod-mode tests below.
STRONG_JWT = "a" * 64


def _all_required_set() -> dict:
    """Return a dict that satisfies every always-required RequiredVar.

    Tests that want to assert "this one var failure causes a raise" start
    from this baseline and then remove or weaken the single var under test.
    """
    return {
        "JWT_SECRET_KEY": STRONG_JWT,
        "DATABASE_URL": "postgresql://test@localhost:5432/test",
        "GOOGLE_CLIENT_ID": "test-client-id",
        "GOOGLE_CLIENT_SECRET": "test-client-secret",
        "FRONTEND_URL": "https://app.example.com",
        "SALESFORCE_CLIENT_ID": "test-sf-client-id",
        "SALESFORCE_CLIENT_SECRET": "test-sf-client-secret",
    }


# ---------------------------------------------------------------------------
# current_environment() — detection precedence
# ---------------------------------------------------------------------------


class TestCurrentEnvironment:
    def test_environment_defaults_to_development(self):
        with patch.dict(os.environ, {}, clear=True):
            assert current_environment() == Environment.DEVELOPMENT

    def test_environment_explicit_var_takes_precedence(self):
        # Explicit ENVIRONMENT=production overrides http FRONTEND_URL
        with patch.dict(
            os.environ,
            {"ENVIRONMENT": "production", "FRONTEND_URL": "http://localhost:3000"},
            clear=True,
        ):
            assert current_environment() == Environment.PRODUCTION

    def test_environment_falls_back_to_frontend_url_heuristic(self):
        # No explicit ENVIRONMENT, https FRONTEND_URL → production
        with patch.dict(
            os.environ, {"FRONTEND_URL": "https://app.example.com"}, clear=True
        ):
            assert current_environment() == Environment.PRODUCTION

    def test_environment_explicit_development_overrides_https_heuristic(self):
        # If operator explicitly sets development, the heuristic must not override
        with patch.dict(
            os.environ,
            {"ENVIRONMENT": "development", "FRONTEND_URL": "https://app.example.com"},
            clear=True,
        ):
            assert current_environment() == Environment.DEVELOPMENT

    def test_environment_staging(self):
        with patch.dict(os.environ, {"ENVIRONMENT": "staging"}, clear=True):
            assert current_environment() == Environment.STAGING


# ---------------------------------------------------------------------------
# validate_jwt_secret_strength() — extracted helper
# ---------------------------------------------------------------------------


class TestValidateJwtSecretStrength:
    def test_none_is_weak(self):
        ok, reason = validate_jwt_secret_strength(None)
        assert ok is False
        assert "missing" in reason

    def test_empty_is_weak(self):
        ok, reason = validate_jwt_secret_strength("")
        assert ok is False
        assert "missing" in reason or "empty" in reason

    def test_too_short_is_weak(self):
        ok, reason = validate_jwt_secret_strength("a" * 16)
        assert ok is False
        assert "too short" in reason

    def test_template_placeholder_is_weak(self):
        ok, reason = validate_jwt_secret_strength(
            "your-very-long-random-secret-key-minimum-32-characters"
        )
        assert ok is False
        assert "forbidden" in reason or "placeholder" in reason

    def test_strong_secret_passes(self):
        ok, reason = validate_jwt_secret_strength(STRONG_JWT)
        assert ok is True
        assert reason is None


# ---------------------------------------------------------------------------
# validate_required_env() — main entrypoint
# ---------------------------------------------------------------------------


class TestValidateRequiredEnv:
    def test_validate_passes_in_dev_with_no_env(self, caplog):
        """Dev mode with no env vars: logs warning, does not raise."""
        with patch.dict(os.environ, {}, clear=True):
            with caplog.at_level(logging.WARNING):
                validate_required_env(Environment.DEVELOPMENT)
            # Should have at least one warning about missing vars
            assert any("missing" in r.message for r in caplog.records)

    def test_validate_raises_in_prod_with_no_env(self):
        """Prod mode with no env vars: raises RuntimeError listing every missing var."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            msg = str(exc_info.value)
            # Every always-required var should appear in the error message
            for var in REQUIRED_VARS:
                if var.condition is None:  # always-required
                    assert var.name in msg, f"{var.name} not in error message"

    def test_validate_passes_in_prod_with_all_required_set(self):
        """Happy path: all always-required vars set, no Sage → passes."""
        with patch.dict(os.environ, _all_required_set(), clear=True):
            # No exception
            validate_required_env(Environment.PRODUCTION)

    def test_validate_raises_on_weak_jwt_secret(self):
        """Prod mode with too-short JWT: raises with min-32 message."""
        env = _all_required_set()
        env["JWT_SECRET_KEY"] = "short"
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            assert "JWT_SECRET_KEY" in str(exc_info.value)
            assert "minimum 32" in str(exc_info.value) or "too short" in str(exc_info.value)

    def test_validate_raises_on_known_forbidden_jwt_value(self):
        """Prod mode with template placeholder JWT: raises."""
        env = _all_required_set()
        env["JWT_SECRET_KEY"] = "your-very-long-random-secret-key-minimum-32-characters"
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            assert "forbidden" in str(exc_info.value) or "placeholder" in str(exc_info.value)

    def test_sage_vars_skipped_when_sage_disabled(self):
        """Prod mode + SAGE_ENABLED=false + sage vars missing → no error."""
        env = _all_required_set()
        env["SAGE_ENABLED"] = "false"
        # No SAGE_* vars set
        with patch.dict(os.environ, env, clear=True):
            validate_required_env(Environment.PRODUCTION)  # no exception

    def test_sage_vars_skipped_when_sage_enabled_unset(self):
        """Prod mode + SAGE_ENABLED unset + sage vars missing → no error (default off)."""
        env = _all_required_set()
        # Deliberately do NOT set SAGE_ENABLED
        with patch.dict(os.environ, env, clear=True):
            validate_required_env(Environment.PRODUCTION)  # no exception

    def test_sage_vars_required_when_sage_enabled(self):
        """Prod mode + SAGE_ENABLED=true + sage vars missing → raises."""
        env = _all_required_set()
        env["SAGE_ENABLED"] = "true"
        # No SAGE_* vars set
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            msg = str(exc_info.value)
            assert "SAGE_COMPANY_ID" in msg
            assert "SAGE_USER_PASSWORD" in msg
            assert "SAGE_SENDER_PASSWORD" in msg

    def test_sage_vars_pass_when_sage_enabled_and_set(self):
        """Prod mode + SAGE_ENABLED=true + all sage vars set → passes."""
        env = _all_required_set()
        env.update({
            "SAGE_ENABLED": "true",
            "SAGE_COMPANY_ID": "test-co",
            "SAGE_USER_ID": "test-user",
            "SAGE_USER_PASSWORD": "real-password",
            "SAGE_SENDER_ID": "test-sender",
            "SAGE_SENDER_PASSWORD": "real-sender-pw",
        })
        with patch.dict(os.environ, env, clear=True):
            validate_required_env(Environment.PRODUCTION)  # no exception

    def test_validate_collects_all_errors_in_one_pass(self):
        """Multiple missing vars → single RuntimeError lists all of them."""
        # Only set one var; everything else missing
        with patch.dict(
            os.environ,
            {"DATABASE_URL": "postgresql://test@localhost/test"},
            clear=True,
        ):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            msg = str(exc_info.value)
            # All other always-required vars should be listed
            assert "JWT_SECRET_KEY" in msg
            assert "GOOGLE_CLIENT_ID" in msg
            assert "GOOGLE_CLIENT_SECRET" in msg
            assert "FRONTEND_URL" in msg
            assert "SALESFORCE_CLIENT_ID" in msg
            assert "SALESFORCE_CLIENT_SECRET" in msg
            # The set var should NOT appear
            assert "DATABASE_URL" not in msg

    def test_validate_treats_whitespace_only_as_missing(self):
        """Empty after strip() should count as missing in prod."""
        env = _all_required_set()
        env["GOOGLE_CLIENT_ID"] = "   "  # whitespace only
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                validate_required_env(Environment.PRODUCTION)
            assert "GOOGLE_CLIENT_ID" in str(exc_info.value)

    def test_validate_uses_current_environment_when_no_arg(self):
        """Calling validate_required_env() with no arg uses current_environment()."""
        # Set ENVIRONMENT=development, leave required vars unset → should warn, not raise
        with patch.dict(os.environ, {"ENVIRONMENT": "development"}, clear=True):
            validate_required_env()  # no exception
