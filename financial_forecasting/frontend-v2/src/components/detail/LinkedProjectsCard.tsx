import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Plus } from "lucide-react";

import { api } from "@/lib/api";
import { useProjects, useCreateProject } from "@/services/projects";

/**
 * Shared "Linked Projects" detail-page card.
 *
 * Lives next to {@link SectionCard} so the four entity detail pages
 * (Account, Opportunity, Contact, Award) render the same UI:
 *   - lists projects linked via the relevant junction table
 *   - lets the user link an existing project
 *   - lets the user create a new project pre-linked to this entity
 *
 * Why one component instead of four near-copies: the only thing that
 * varies between entities is the junction-table endpoint pair. Keeping
 * the JSX in one place is the difference between a one-line change and
 * a four-page coordination problem next time we tweak the design.
 */

export type LinkedEntity = "account" | "opportunity" | "contact" | "award";

interface LinkedProjectsCardProps {
  /** Junction-table side this card is rendered on. */
  entityType: LinkedEntity;
  /** Entity id (Salesforce 15/18-char id, or UUID for awards). */
  entityId: string;
  /** Visible referrer label used on outbound links ("Account", "Opportunity"…). */
  referrerLabel: string;
  /**
   * Optional additional reverse-lookup sources whose projects should be
   * merged into the display. Used by the Account detail page so a project
   * linked to *any* opp or award on the account also appears, even if it
   * isn't linked to the account directly. The "Link" action still writes
   * to the primary `entityType` — these are read-only secondary sources.
   */
  alsoFrom?: { type: LinkedEntity; id: string }[];
}

interface LinkedProjectRow {
  id: string;
  name: string;
  /** How this project showed up in the merged list, for tooltip / tag.
   *  `direct` means it came from the entity's own reverse lookup; anything
   *  else means it was pulled in via the `alsoFrom` secondary sources. */
  via: "direct" | LinkedEntity;
}

const ENTITY_PLURAL: Record<LinkedEntity, string> = {
  account: "accounts",
  opportunity: "opportunities",
  contact: "contacts",
  award: "awards",
};

export function LinkedProjectsCard({
  entityType,
  entityId,
  referrerLabel,
  alsoFrom,
}: LinkedProjectsCardProps) {
  const location = useLocation();
  const referrer = { from: { pathname: location.pathname, label: referrerLabel } };

  const qc = useQueryClient();
  const projectsQ = useProjects();
  const createProject = useCreateProject();

  const reverseQueryKey = ["linked-projects", entityType, entityId];

  // Primary source — the entity's own reverse-lookup endpoint.
  const linkedQ = useQuery({
    queryKey: reverseQueryKey,
    queryFn: async () => {
      const { data } = await api.get<{ data: { id: string; name: string }[] }>(
        `/api/${ENTITY_PLURAL[entityType]}/${entityId}/projects`,
      );
      return data?.data ?? [];
    },
    staleTime: 30_000,
    enabled: Boolean(entityId),
  });

  // Secondary sources (e.g. all of an account's opps/awards). Each is its
  // own React-Query so the user-facing detail page reuses any cached
  // result that was already fetched elsewhere (e.g. the same opp's
  // /projects call from another card).
  const extras = alsoFrom ?? [];
  const extraQs = useQueries({
    queries: extras.map((src) => ({
      queryKey: ["linked-projects", src.type, src.id],
      queryFn: async () => {
        const { data } = await api.get<{ data: { id: string; name: string }[] }>(
          `/api/${ENTITY_PLURAL[src.type]}/${src.id}/projects`,
        );
        return data?.data ?? [];
      },
      staleTime: 30_000,
      enabled: Boolean(src.id),
    })),
  });

  // Merge: primary source wins on collision (so direct links keep their
  // "direct" badge even if the project also shows up via an opp/award).
  const linked: LinkedProjectRow[] = useMemo(() => {
    const seen = new Map<string, LinkedProjectRow>();
    for (const p of linkedQ.data ?? []) {
      seen.set(p.id, { id: p.id, name: p.name, via: "direct" });
    }
    extras.forEach((src, i) => {
      for (const p of (extraQs[i]?.data ?? [])) {
        if (seen.has(p.id)) continue;
        seen.set(p.id, { id: p.id, name: p.name, via: src.type });
      }
    });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [linkedQ.data, extraQs, extras]);

  const linkedIds = new Set(linked.map((p) => p.id));
  const linkable = (projectsQ.data ?? []).filter((p) => !linkedIds.has(p.id));
  const isLoading = linkedQ.isLoading || extraQs.some((q) => q.isLoading);

  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");

  async function linkProject(projectId: string) {
    // The opportunity-link endpoint predates the other M2M routes and uses a
    // different payload shape (it carries a `role` field). The other three
    // share the generic {entity_id} contract.
    const body =
      entityType === "opportunity"
        ? { opportunity_id: entityId }
        : { entity_id: entityId };
    await api.post(`/api/projects/${projectId}/${ENTITY_PLURAL[entityType]}`, body);
    qc.invalidateQueries({ queryKey: reverseQueryKey });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    qc.invalidateQueries({ queryKey: ["project-opportunities", projectId] });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const project = await createProject.mutateAsync({ name: name.trim() });
    await linkProject(project.id);
    setName("");
    setCreating(false);
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] text-ink-3">
          {linked.length} project{linked.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setLinking(true);
              setCreating(false);
            }}
            className="text-[11.5px] text-ink-3 hover:text-ink-2"
          >
            Link
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setLinking(false);
            }}
            className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface hover:opacity-90"
          >
            <Plus size={10} /> New
          </button>
        </div>
      </div>

      {creating ? (
        <form className="mb-2 flex items-center gap-1.5" onSubmit={handleCreate}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface"
          >
            Create
          </button>
        </form>
      ) : null}

      {linking ? (
        <form
          className="mb-2 flex items-center gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pick) return;
            await linkProject(pick);
            setPick("");
            setLinking(false);
          }}
        >
          <select
            autoFocus
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent"
          >
            <option value="">Select project…</option>
            {linkable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded bg-accent px-2 py-0.5 text-[11.5px] text-surface"
          >
            Link
          </button>
        </form>
      ) : null}

      {isLoading ? (
        <div className="text-[12px] text-ink-4">Loading…</div>
      ) : linked.length === 0 ? (
        <div className="text-[12px] text-ink-4">No projects linked.</div>
      ) : (
        <ul className="space-y-1">
          {linked.map((p) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                state={referrer}
                className="group flex items-center gap-2 rounded border border-border-strong bg-surface px-3 py-1.5 hover:border-accent"
              >
                <span className="flex-1 truncate text-[12.5px] font-medium text-ink">
                  {p.name}
                </span>
                {p.via !== "direct" ? (
                  <span
                    className="flex-shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-3"
                    title={`Linked via ${p.via}, not to this ${entityType} directly`}
                  >
                    via {p.via}
                  </span>
                ) : null}
                <ExternalLink
                  size={11}
                  className="flex-shrink-0 text-ink-4 group-hover:text-accent"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
