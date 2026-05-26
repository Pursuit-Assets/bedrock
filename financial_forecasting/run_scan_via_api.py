"""Mint a local admin JWT and call the dry-run scan endpoint."""
import asyncio
import os
import sys
import json
from datetime import datetime, timedelta

from dotenv import load_dotenv
load_dotenv()
sys.path.insert(0, os.path.dirname(__file__))

import httpx
from jose import jwt

JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
JWT_ALGORITHM = "HS256"


def make_admin_token() -> str:
    payload = {
        "email": "jac@pursuit.org",
        "name": "Jacqueline Reverand",
        "exp": datetime.utcnow() + timedelta(hours=4),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


async def main():
    token = make_admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    cookies = {"access_token": token}

    async with httpx.AsyncClient(timeout=600) as client:
        # dry run first
        print("Starting background scan (limit=20000)…")
        r = await client.post(
            "http://localhost:8000/api/admin/sf-contact-match/scan",
            params={"dry_run": "false", "limit": "20000", "background": "true"},
            cookies=cookies,
        )
        print(f"Status: {r.status_code} — {r.json()}")

        print("Polling for completion…")
        while True:
            await asyncio.sleep(30)
            r2 = await client.get(
                "http://localhost:8000/api/admin/sf-contact-match/scan/status",
                cookies=cookies,
            )
            status = r2.json().get("data", {})
            print(f"  running={status.get('running')}  last_summary={status.get('last_summary')}")
            if not status.get("running") and status.get("last_summary") is not None:
                print("\n=== Final summary ===")
                print(json.dumps(status["last_summary"], indent=2, default=str))
                break


if __name__ == "__main__":
    asyncio.run(main())
