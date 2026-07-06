#!/usr/bin/env python3
"""Backfill all opportunity-linked placements into Salesforce.

Runs services.placement_sf.sync_placement_to_sf for every
public.employment_records row with an opportunity_id (i.e. every hire made
through bedrock so far), using a small REST shim with the same query/
create_record interface as the app's SF client. Idempotent — re-running
finds instead of creating.

Token: scratchpad sf_tokens.json (OAuth). Set SF_TOKENS env to override.
"""
import asyncio, json, os, sys

import requests
from dotenv import load_dotenv

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
load_dotenv(os.path.join(HERE, ".env"))

import asyncpg  # noqa: E402
from services.placement_sf import sync_placement_to_sf, record_sync_error, NotEligible  # noqa: E402

TOKENS = os.environ.get("SF_TOKENS", "/private/tmp/claude-501/-Users-jacquelinereverand/8141f3c4-1b15-4acb-97d5-130954da8a1d/scratchpad/sf_tokens.json")


class RestSF:
    """Minimal async-compatible shim matching the app's sf interface.

    Auth: a tokens file when present (local OAuth), else SalesforceLogin
    with env creds — the latter only works from allowlisted IPs (Cloud Run),
    which is how the cloud backfill execution authenticates."""

    def __init__(self, tokens_path: str):
        if os.path.exists(tokens_path):
            t = json.load(open(tokens_path))
            inst, sid = t["instance_url"], t["access_token"]
        else:
            from simple_salesforce import SalesforceLogin
            sid, host = SalesforceLogin(
                username=os.environ["SALESFORCE_USERNAME"],
                password=os.environ["SALESFORCE_PASSWORD"],
                security_token=os.environ.get("SALESFORCE_SECURITY_TOKEN", ""),
                domain=os.environ.get("SALESFORCE_DOMAIN", "login"))
            inst = f"https://{host}"
        self.inst = inst
        self.h = {"Authorization": f"Bearer {sid}", "Content-Type": "application/json"}

    async def query(self, soql: str) -> dict:
        r = requests.get(f"{self.inst}/services/data/v59.0/query", params={"q": soql}, headers=self.h, timeout=30)
        if not r.ok:
            raise RuntimeError(f"SOQL {r.status_code}: {r.text[:300]}")
        return r.json()

    async def create_record(self, sobject: str, data: dict) -> dict:
        r = requests.post(f"{self.inst}/services/data/v59.0/sobjects/{sobject}", json=data, headers=self.h, timeout=30)
        if r.status_code not in (200, 201):
            raise RuntimeError(f"create {sobject} {r.status_code}: {r.text[:300]}")
        return r.json()


async def main():
    sf = RestSF(TOKENS)
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    ers = await conn.fetch(
        "SELECT id FROM public.employment_records ORDER BY id")
    ok = err = 0
    for er in ers:
        try:
            res = await sync_placement_to_sf(conn, sf, er["id"])
            made = [k.replace("created_", "") for k in ("created_contact", "created_account", "created_affiliation") if res[k]]
            print(f"  er {er['id']}: synced" + (f" (created {', '.join(made)})" if made else " (all existed)"))
            ok += 1
        except NotEligible as ne:
            await record_sync_error(conn, er["id"], str(ne), status="skipped")
            print(f"  er {er['id']}: skipped — {ne}")
        except Exception as e:
            await record_sync_error(conn, er["id"], str(e))
            print(f"  er {er['id']}: ERROR — {e}")
            err += 1
    print(f"\nbackfill: {ok} synced, {err} errors of {len(ers)} placements")
    await conn.close()


asyncio.run(main())
