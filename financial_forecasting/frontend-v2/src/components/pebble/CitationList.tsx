/**
 * CitationList — numbered footnote list for the citations attached
 * to a Pebble final response.
 *
 * Each citation links to the entity detail page where one exists
 * (citation.href is computed server-side in renderer._maybe_build_href).
 * Otherwise renders as inert text — defensive against malformed cites.
 */

import { Link as LinkIcon } from "lucide-react";
import { Link as RouterLink } from "react-router-dom";

import type { Citation } from "@/types/pebble";

export function CitationList({ citations }: { citations: Citation[] }) {
  if (!citations || citations.length === 0) return null;

  return (
    <section
      aria-label="Sources"
      className="mt-3 border-t border-border-strong pt-2"
    >
      <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        Sources
      </h4>
      <ol className="flex flex-col gap-0.5 text-[12px] text-ink-2">
        {citations.map((c, i) => (
          <li key={c.cite_id || `${c.entity_type}:${c.entity_id}`} className="flex items-start gap-1.5">
            <span className="mt-px text-ink-4 tabular-nums">{i + 1}.</span>
            {c.href ? (
              <RouterLink
                to={c.href}
                className="flex items-center gap-1 text-ink hover:underline"
              >
                <LinkIcon size={11} className="flex-shrink-0 opacity-70" />
                <span className="truncate">{c.title || `${c.entity_type}:${c.entity_id}`}</span>
              </RouterLink>
            ) : (
              <span className="truncate text-ink-3">
                {c.title || `${c.entity_type}:${c.entity_id}`}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
