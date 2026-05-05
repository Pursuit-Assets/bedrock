import axios, { type AxiosInstance } from "axios";

/**
 * API client for the FastAPI backend (financial_forecasting/main.py).
 *
 * In dev, Vite proxies /api/* → http://localhost:8000 (see vite.config.ts).
 * In prod, set VITE_API_URL to point at the deployed backend.
 *
 * Auth: cookie-based, mirroring the legacy CRA frontend at
 * `financial_forecasting/frontend/src/services/api.ts`. The backend reads
 * `access_token` from cookies (auth.py:65). `withCredentials: true` makes
 * the browser include cookies on cross-origin requests so production
 * deployments work the same as dev (where the Vite proxy makes everything
 * same-origin anyway).
 */
/**
 * Default timeout: 60s. Salesforce SOQL/Apex roundtrips routinely take
 * 5-15s under normal load and can spike past 30s during peak hours
 * (especially mutations that fire org-wide validation rules + flows).
 *
 * Faster failures aren't a virtue — they just produce false negatives
 * we then have to retry by hand. 60s lets the long tail of legitimate
 * SF responses complete; transient failures past 60s are caught by the
 * runBulk retry-with-backoff layer for bulk ops, and surface as a real
 * error for one-off calls (where the user can hit save again).
 */
export const api: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "",
  timeout: 60_000,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});
