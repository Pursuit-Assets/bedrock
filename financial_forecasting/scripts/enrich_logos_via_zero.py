"""One-off bulk logo enrichment via Zero CLI → Apollo.

Pipeline:
  1. GET /api/admin/sf-company-match/enrichment-candidates
       (matched accounts with a domain set; only_missing=True by default)
  2. For each batch of 10 domains: shell out to
       `zero fetch --capability apollo-bulk-org-enrichment-f46e86d5
                   -d '{"domains": "a.com,b.com,..."}'`
       — pays $0.008 USDC per call (capped to 10 domains).
  3. POST results to /api/admin/sf-company-match/bulk-update-logos
       (writes Apollo's `logo_url` into public.companies.logo_url and
        bumps enrichment_source/enriched_at).

Auth: pulls a session cookie from BEDROCK_ADMIN_COOKIE env var, or
prompts. Backend already requires admin via require_admin.

Cost: 1,295 matched / 10 = ~130 calls × $0.008 = ~$1.04. Wallet has
$10.49 USDC at last check. Pass --dry-run to skip the write phase.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any

import requests

API_BASE = os.environ.get("BEDROCK_API_BASE", "http://127.0.0.1:8000")
CAPABILITY_ID = "apollo-bulk-org-enrichment-f46e86d5"
BATCH_SIZE = 10


def fetch_candidates(cookie: str) -> list[dict[str, Any]]:
    r = requests.get(
        f"{API_BASE}/api/admin/sf-company-match/enrichment-candidates",
        params={"only_missing": "true", "limit": 5000},
        headers={"Cookie": cookie},
        timeout=30,
    )
    r.raise_for_status()
    payload = r.json()
    return payload["data"]


def apollo_bulk(domains: list[str]) -> dict[str, str]:
    """Returns {domain: logo_url}. Domains without a logo are omitted.

    Apollo bulk endpoint:
      - Input: {"domains": ["a.com", "b.com", ...]}  (max 10)
      - Output: {"data": {"organizations": [org | null, ...]}}
        — `null` slots for domains it couldn't resolve.
    """
    body = json.dumps({"domains": domains})
    out = subprocess.run(
        ["zero", "fetch", "--capability", CAPABILITY_ID, "-d", body],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if out.returncode != 0:
        print(f"  zero fetch failed: {out.stderr}", file=sys.stderr)
        return {}
    json_line = next(
        (ln for ln in out.stdout.splitlines() if ln.lstrip().startswith("{")),
        None,
    )
    if not json_line:
        print(f"  no JSON in zero output:\n{out.stdout}", file=sys.stderr)
        return {}
    try:
        data = json.loads(json_line)
    except json.JSONDecodeError as e:
        print(f"  JSON parse error: {e}", file=sys.stderr)
        return {}

    if data.get("error") or not data.get("success", True):
        print(f"  apollo error: {data}", file=sys.stderr)
        return {}

    orgs = data.get("data", {}).get("organizations", []) or []
    out_map: dict[str, str] = {}
    for org in orgs:
        if not org:
            continue
        domain = (org.get("primary_domain") or "").lower().strip()
        logo = org.get("logo_url")
        if domain and logo:
            out_map[domain] = logo
    return out_map


def post_updates(cookie: str, updates: list[dict[str, Any]]) -> int:
    r = requests.post(
        f"{API_BASE}/api/admin/sf-company-match/bulk-update-logos",
        json={"updates": updates, "source": "apollo_zero"},
        headers={"Cookie": cookie, "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["data"]["updated"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                        help="Run Apollo lookups, save to /tmp, don't write to DB.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Cap number of domains processed. Default: all candidates.")
    args = parser.parse_args()

    cookie = os.environ.get("BEDROCK_ADMIN_COOKIE")
    if not cookie:
        print("Set BEDROCK_ADMIN_COOKIE env var (copy from browser devtools).",
              file=sys.stderr)
        return 1

    print(f"Fetching enrichment candidates from {API_BASE}…")
    candidates = fetch_candidates(cookie)
    if args.limit:
        candidates = candidates[: args.limit]
    print(f"  → {len(candidates)} accounts to enrich.")

    # Map domain → company_id so we can rejoin Apollo's response to
    # public.companies rows. (Apollo can normalize a domain — strip www
    # etc — so we lowercase + strip on both sides for the lookup.)
    by_domain = {(c["domain"] or "").lower().strip(): c["company_id"]
                 for c in candidates}

    updates: list[dict[str, Any]] = []
    domains = list(by_domain.keys())
    total_calls = (len(domains) + BATCH_SIZE - 1) // BATCH_SIZE
    for i in range(0, len(domains), BATCH_SIZE):
        chunk = domains[i : i + BATCH_SIZE]
        call_n = i // BATCH_SIZE + 1
        print(f"  [{call_n}/{total_calls}] Apollo bulk: {len(chunk)} domains…")
        result = apollo_bulk(chunk)
        for domain, logo_url in result.items():
            cid = by_domain.get(domain)
            if cid is None:
                # Apollo's primary_domain didn't match exactly — try a
                # softer match by stripping subdomain prefixes.
                for cand_domain, cand_cid in by_domain.items():
                    if cand_domain.endswith(domain) or domain.endswith(cand_domain):
                        cid = cand_cid
                        break
            if cid is not None:
                updates.append({"public_company_id": cid, "logo_url": logo_url})
        time.sleep(0.5)  # gentle on the gateway

    print(f"\nApollo returned logos for {len(updates)} of {len(domains)} domains.")

    out_path = "/tmp/apollo_logos.json"
    with open(out_path, "w") as f:
        json.dump(updates, f, indent=2)
    print(f"  Saved to {out_path}")

    if args.dry_run:
        print("Dry run — skipping DB write. Re-run without --dry-run to apply.")
        return 0

    if not updates:
        print("Nothing to write.")
        return 0

    n = post_updates(cookie, updates)
    print(f"\nUpdated {n} rows in public.companies.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
