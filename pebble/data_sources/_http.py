"""Shared async HTTP client for the data_sources package (P1).

Replaces the per-call ``httpx.get(...)`` pattern (with ``asyncio.to_thread``
at every callsite) with a single ``httpx.AsyncClient`` reused across
fetches. Wins:

  * Connection pooling — one TCP/TLS handshake per host, reused for
    every subsequent fetch.
  * No threadpool starvation under concurrent batches — async-native
    fan-out lets 450 fetches (50 prospects × 9 sources) run truly in
    parallel rather than queueing on the 32-worker default pool.
  * 429 backoff uses ``asyncio.sleep`` so the event loop keeps moving.

The client is lazily created on first call and cached for the process
lifetime. Tests that need transport mocking can monkeypatch
``get_client()`` to return an ``httpx.AsyncClient(transport=
httpx.MockTransport(...))``. ``close_client()`` is exposed for
shutdown hooks.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger("pebble.data_sources.http")

_DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=5.0, read=30.0)
_DEFAULT_HEADERS = {"User-Agent": "Pebble Research/1.0"}

_client: Optional[httpx.AsyncClient] = None
_lock = asyncio.Lock()


async def get_client() -> httpx.AsyncClient:
    """Return the process-wide shared async client. Lazy + idempotent."""
    global _client
    if _client is not None and not _client.is_closed:
        return _client
    async with _lock:
        if _client is None or _client.is_closed:
            _client = httpx.AsyncClient(
                timeout=_DEFAULT_TIMEOUT,
                follow_redirects=True,
                headers=_DEFAULT_HEADERS,
            )
            logger.debug("data_sources async client created")
    return _client


async def close_client() -> None:
    """Close the shared client. Idempotent; safe to call at shutdown."""
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        logger.debug("data_sources async client closed")
    _client = None


async def get_with_retry(
    url: str,
    *,
    params: dict | None = None,
    headers: dict | None = None,
    max_retries: int = 2,
    backoff_base: float = 2.0,
    breaker: object | None = None,
) -> httpx.Response | None:
    """GET with 429-aware backoff. Returns the Response on 2xx/3xx,
    None on terminal failure. Generalizes the retry loop that lived in
    each data_source module.

    Optional ``breaker`` (CircuitBreaker-shaped) is checked before the
    call and recorded after: is_open() short-circuits, record_success()
    on 2xx/3xx, record_failure() on terminal error / 4xx / 5xx."""
    if breaker is not None and getattr(breaker, "is_open", lambda: False)():
        logger.debug("circuit open for %s — skipping", url)
        return None
    client = await get_client()
    for attempt in range(max_retries + 1):
        try:
            r = await client.get(url, params=params, headers=headers)
        except httpx.HTTPError as e:
            logger.debug("HTTP error on attempt %d for %s: %s", attempt, url, e)
            if breaker is not None:
                breaker.record_failure()
            return None
        if r.status_code == 429 and attempt < max_retries:
            await asyncio.sleep(backoff_base ** attempt)
            continue
        if r.status_code >= 400:
            logger.debug("HTTP %d for %s (attempt %d)", r.status_code, url, attempt)
            if breaker is not None:
                breaker.record_failure()
            return None
        if breaker is not None:
            breaker.record_success()
        return r
    if breaker is not None:
        breaker.record_failure()
    return None


async def post_with_retry(
    url: str,
    *,
    json: dict | None = None,
    headers: dict | None = None,
    max_retries: int = 2,
    backoff_base: float = 2.0,
    breaker: object | None = None,
) -> httpx.Response | None:
    """POST variant of get_with_retry. Same 429 backoff + breaker
    semantics."""
    if breaker is not None and getattr(breaker, "is_open", lambda: False)():
        logger.debug("circuit open for %s — skipping", url)
        return None
    client = await get_client()
    for attempt in range(max_retries + 1):
        try:
            r = await client.post(url, json=json, headers=headers)
        except httpx.HTTPError as e:
            logger.debug("HTTP error on attempt %d for %s: %s", attempt, url, e)
            if breaker is not None:
                breaker.record_failure()
            return None
        if r.status_code == 429 and attempt < max_retries:
            await asyncio.sleep(backoff_base ** attempt)
            continue
        if r.status_code >= 400:
            logger.debug("HTTP %d for %s (attempt %d)", r.status_code, url, attempt)
            if breaker is not None:
                breaker.record_failure()
            return None
        if breaker is not None:
            breaker.record_success()
        return r
    if breaker is not None:
        breaker.record_failure()
    return None
