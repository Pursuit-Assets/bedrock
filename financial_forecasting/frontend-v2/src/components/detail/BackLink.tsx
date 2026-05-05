/**
 * Smart back arrow for detail pages.
 *
 * Reads the {@link DetailReferrer} from router state — set by source
 * pages via {@link useCurrentReferrer} or {@link withReferrer} — and
 * falls back to a sensible default when state is absent (direct URL
 * visit, shared link, refresh after state loss).
 */
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { useReferrer } from "./referrer";

export interface BackLinkProps {
  /** Pathname to use when no referrer is in router state. */
  defaultTo: string;
  /** Label shown when no referrer is in router state. */
  defaultLabel: string;
}

export function BackLink({ defaultTo, defaultLabel }: BackLinkProps) {
  const referrer = useReferrer();
  const to = referrer
    ? { pathname: referrer.pathname, search: referrer.search ?? "" }
    : defaultTo;
  const label = referrer?.label ?? defaultLabel;
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink"
    >
      <ArrowLeft size={14} aria-hidden="true" /> {label}
    </Link>
  );
}
