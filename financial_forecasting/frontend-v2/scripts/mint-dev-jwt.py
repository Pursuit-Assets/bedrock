"""Mint a JWT for local dev / Playwright testing.

The backend (`financial_forecasting/auth.py`) signs `access_token` cookies
with `JWT_SECRET_KEY` from `.env`, HS256, 30-day expiry. This script reads
that same secret and mints a token Playwright can attach as a cookie —
giving us "logged-in" navigation without going through Google OAuth.

Output: prints just the JWT to stdout (so it's pipeable). Use:

    JWT=$(python3 frontend-v2/scripts/mint-dev-jwt.py)

Default user is `jac@pursuit.org`. Override via env:

    EMAIL=other@pursuit.org NAME='Other Person' \\
      python3 frontend-v2/scripts/mint-dev-jwt.py

Reads `.env` from `../` (i.e. `financial_forecasting/.env`).
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from jose import jwt

ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=False)

secret = os.getenv("JWT_SECRET_KEY")
if not secret:
    sys.exit(
        f"JWT_SECRET_KEY not found. Looked in {ENV_PATH}. "
        "Set it in financial_forecasting/.env or export it."
    )

email = os.getenv("EMAIL", "jac@pursuit.org")
name = os.getenv("NAME", "Jac (dev)")

payload = {
    "email": email,
    "name": name,
    "picture": "",
    "sub": f"dev-{email}",
    "exp": datetime.now(timezone.utc) + timedelta(days=30),
}

token = jwt.encode(payload, secret, algorithm="HS256")
print(token)
