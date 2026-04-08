# Google OAuth Setup

**Date:** 2026-03-19 (created) | 2026-03-20 (completed)
**Status:** DONE

## Setup Details

- **Google Cloud Project:** Pursuit's existing GCP project
- **OAuth Client Type:** Web application
- **Credentials location:** `financial_forecasting/.env` (gitignored)
- **Required env vars:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- **How to find credentials:** [Google Cloud Console > APIs & Credentials](https://console.cloud.google.com/apis/credentials) > OAuth 2.0 Client IDs

## Redirect URIs Configured

**Development:**
```
http://localhost:8000/auth/google/callback
```

**Production (when deployed):**
```
https://financial-forecasting-api-XXXXXX.run.app/auth/google/callback
```

## Authorized JavaScript Origins

```
http://localhost:3000
```

## OAuth Scopes Requested

```
openid email profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/drive.readonly
```

## What Works

- Google OAuth login flow (frontend Login.tsx > backend /auth/google > Google consent > callback > JWT cookie)
- Session persistence via JWT (30-day expiration)
- Google API token encryption (Fernet, derived from JWT_SECRET_KEY)
- Optional email allowlist via `ALLOWED_EMAILS` env var
- ~~Dev bypass available via `REACT_APP_DEV_BYPASS=true`~~ — REMOVED 2026-04-08. All environments require real Google OAuth.

## For New Developers

1. Get Client ID and Secret from the Google Cloud Console (ask a team admin)
2. Add to `financial_forecasting/.env`:
   ```env
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:8000/auth/google/callback
   ```
3. Restart the backend
4. Full setup docs: `financial_forecasting/OAUTH_SETUP.md`
