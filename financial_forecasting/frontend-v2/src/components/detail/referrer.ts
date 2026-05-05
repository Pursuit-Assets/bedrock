/**
 * Smart-back routing helpers.
 *
 * Detail pages used to hard-code a `<Link to="/accounts">`-style back
 * arrow, which broke flows like Cleanup → Account → back (returned to
 * /accounts instead of /cleanup). Source pages now pass a referrer in
 * the router `state`, and the shared {@link BackLink} reads it.
 *
 * Direct URL visits (no state) still work — the BackLink falls back to
 * a `defaultTo` + `defaultLabel` prop.
 *
 * Why router state instead of `useNavigate(-1)`:
 *   - Direct links / refreshes / shared URLs would otherwise back-out
 *     of the app or to an unrelated tab.
 *   - The label adapts to the source ("Back to Cleanup" vs "Back to
 *     Accounts") which is more explicit than a browser-history arrow.
 */
import { useLocation } from "react-router-dom";

/** Where to return to. Captured at link-time on the source page. */
export interface DetailReferrer {
  /** Target pathname (e.g. "/cleanup"). */
  pathname: string;
  /** Optional querystring including leading "?". */
  search?: string;
  /** Visible label rendered in the back arrow ("Cleanup", "Pipeline"). */
  label: string;
}

/** Shape stored in router state on detail pages. */
export interface DetailReferrerState {
  from?: DetailReferrer;
}

/** Helper for `<Link state={...}>` on source pages. */
export function withReferrer(from: DetailReferrer): DetailReferrerState {
  return { from };
}

/**
 * Capture the *current* page as the referrer for outbound detail links.
 * Use on list/cleanup/drawer source pages — preserves both pathname
 * and querystring so e.g. filtered-list state survives the round-trip.
 *
 *   const referrer = useCurrentReferrer("Cleanup");
 *   <Link to={`/accounts/${id}`} state={referrer} />
 */
export function useCurrentReferrer(label: string): DetailReferrerState {
  const location = useLocation();
  return {
    from: {
      pathname: location.pathname,
      search: location.search || undefined,
      label,
    },
  };
}

/**
 * Read the referrer off router state on a detail page. Returns null
 * when none was supplied (direct visit / shared URL).
 */
export function useReferrer(): DetailReferrer | null {
  const location = useLocation();
  const state = location.state as DetailReferrerState | null;
  return state?.from ?? null;
}
