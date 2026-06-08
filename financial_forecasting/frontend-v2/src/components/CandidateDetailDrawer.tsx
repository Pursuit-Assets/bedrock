/**
 * Smart-suggestion drawer for the candidate funnel.
 *
 * Renders all the enrichment from /detail so an RM can decide in one
 * glance whether to promote, tag, or reject — no extra searching:
 *  - extracted display name + counterparts at Pursuit
 *  - recent activity preview (subject + snippet)
 *  - public.contacts matches at the same domain (LinkedIn URL highlighted)
 *  - SF Account suggestion from the domain map
 *
 * Action buttons pre-fill from the surfaced suggestions — one click to
 * tag to a known match instead of typing the SF Id.
 */
import { Linkedin, Mail, User, Users } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import {
  type AccountCandidate,
  type ContactCandidate,
  type PublicContactMatch,
  useAccountCandidateDetail,
  useAccountCandidateSimple,
  useContactCandidateDetail,
  useContactCandidateSimple,
  usePromoteAccountToSf,
  usePromoteContactToSf,
  useTagAccountToExisting,
  useTagContactToExisting,
} from "@/services/candidates";

// ── Contact drawer ────────────────────────────────────────────────────

export function ContactCandidateDrawer({
  candidate, onClose,
}: {
  candidate: ContactCandidate | null;
  onClose: () => void;
}) {
  const open = !!candidate;
  const detailQ = useContactCandidateDetail(candidate?.id ?? null);
  const track = useContactCandidateSimple("track");
  const reject = useContactCandidateSimple("reject");
  const promote = usePromoteContactToSf();
  const tag = useTagContactToExisting();

  const d = detailQ.data;
  const title = d?.display_name ?? candidate?.display_name ?? candidate?.email ?? "Candidate";
  const subtitle = d?.email ?? candidate?.email;

  const handleTagToPublicMatch = (m: PublicContactMatch) => {
    if (!candidate) return;
    if (!m.sf_contact_id) {
      const [first, ...rest] = (m.full_name || "").split(" ");
      promote.mutate(
        {
          id: candidate.id,
          first_name: first || m.first_name || "Unknown",
          last_name: rest.join(" ") || m.last_name || "Unknown",
          sf_account_id: m.sf_account_id ?? d?.sf_account_id ?? undefined,
          title: m.current_title ?? undefined,
        },
        { onSuccess: onClose },
      );
      return;
    }
    tag.mutate(
      { id: candidate.id, sf_contact_id: m.sf_contact_id, sf_account_id: m.sf_account_id ?? undefined },
      { onSuccess: onClose },
    );
  };

  const handlePromoteFresh = () => {
    if (!candidate || !d) return;
    const namePart = (d.display_name || candidate.email.split("@")[0] || "").trim();
    const parts = namePart.split(/\s+/);
    const first = window.prompt("First name", parts[0] || "") || "";
    if (!first) return;
    const last = window.prompt("Last name", parts.slice(1).join(" ") || "") || "";
    if (!last) return;
    const acct = d.sf_account_id ?? d.sf_account_suggestion?.sf_account_id;
    promote.mutate(
      {
        id: candidate.id, first_name: first, last_name: last,
        sf_account_id: acct ?? undefined,
      },
      { onSuccess: onClose },
    );
  };

  const handleTagViaSfId = () => {
    if (!candidate) return;
    const sfId = window.prompt("SF Contact Id (18-char) to tag this person to:");
    if (!sfId) return;
    const acct = window.prompt("(optional) SF Account Id", d?.sf_account_id ?? "") || undefined;
    tag.mutate({ id: candidate.id, sf_contact_id: sfId.trim(), sf_account_id: acct },
      { onSuccess: onClose });
  };

  const handleReject = () => {
    if (!candidate) return;
    const notes = window.prompt("Reason (optional):", "") || undefined;
    reject.mutate({ id: candidate.id, notes }, { onSuccess: onClose });
  };

  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle}>
      {!d ? (
        <div className="p-6 text-text-muted">{detailQ.isError ? "Failed to load." : "Loading…"}</div>
      ) : (
        <div className="space-y-5 p-4">
          {/* Top banner — context at a glance */}
          <SignalRow
            signals={d.signal_count}
            firstSeen={d.first_seen_at}
            lastSeen={d.last_seen_at}
            status={d.status}
          />

          {/* SF Account context */}
          {d.sf_account_id ? (
            <Card title="Linked SF Account">
              <div className="text-sm">{d.sf_account_name ?? d.sf_account_id}</div>
              <div className="text-xs text-text-muted">{d.sf_account_id}</div>
            </Card>
          ) : d.sf_account_suggestion ? (
            <Card title="Suggested SF Account (from domain map)" tone="info">
              <div className="text-sm">
                {d.sf_account_suggestion.sf_account_name ?? d.sf_account_suggestion.sf_account_id}
              </div>
              <div className="text-xs text-text-muted">{d.sf_account_suggestion.sf_account_id}</div>
            </Card>
          ) : null}

          {/* Pursuit counterparts */}
          {d.internal_counterparts.length > 0 && (
            <Card title="Internal contacts" icon={<Users className="h-3.5 w-3.5" />}>
              <ul className="space-y-1">
                {d.internal_counterparts.map((c) => (
                  <li key={c.email} className="flex items-center justify-between text-sm">
                    <span>{c.display_name}</span>
                    <span className="text-text-muted text-xs">
                      {c.interaction_count} interaction{c.interaction_count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* LinkedIn / registry matches */}
          {(d.public_contact_exact_match || d.public_contacts_same_domain.length > 0) && (
            <Card
              title="Pursuit registry matches"
              icon={<Linkedin className="h-3.5 w-3.5" />}
              subtitle="Click a match to tag this candidate to it (one click — no typing)"
            >
              <div className="space-y-2">
                {d.public_contact_exact_match && (
                  <PublicContactRow
                    match={d.public_contact_exact_match}
                    exact
                    onTag={() => handleTagToPublicMatch(d.public_contact_exact_match!)}
                    busy={tag.isPending || promote.isPending}
                  />
                )}
                {d.public_contacts_same_domain.slice(0, 6).map((m) => (
                  <PublicContactRow
                    key={m.contact_id}
                    match={m}
                    onTag={() => handleTagToPublicMatch(m)}
                    busy={tag.isPending || promote.isPending}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* Recent activity */}
          {d.recent_activity.length > 0 && (
            <Card
              title={`Recent activity (${d.total_activity_count} total)`}
              icon={<Mail className="h-3.5 w-3.5" />}
            >
              <ul className="space-y-2">
                {d.recent_activity.slice(0, 5).map((a, i) => (
                  <li key={i} className="border-l-2 border-border-subtle pl-2">
                    <div className="text-xs text-text-muted">
                      {fmtDateTime(a.activity_date)} · {a.source} · {a.type}
                    </div>
                    {a.subject && <div className="text-sm font-medium truncate">{a.subject}</div>}
                    {a.snippet && <div className="text-xs text-text-muted line-clamp-2">{a.snippet}</div>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Catch-all actions */}
          <div className="sticky bottom-0 -mx-4 mt-3 flex flex-wrap gap-2 border-t border-border-subtle bg-surface p-3">
            {!d.sf_contact_id && (
              <ActionButton onClick={handlePromoteFresh} variant="primary" disabled={promote.isPending}>
                Open as new SF Contact
              </ActionButton>
            )}
            <ActionButton onClick={handleTagViaSfId} disabled={tag.isPending}>
              Tag by SF Contact Id…
            </ActionButton>
            <ActionButton
              onClick={() => candidate && track.mutate({ id: candidate.id }, { onSuccess: onClose })}
              disabled={track.isPending}
            >
              Track only
            </ActionButton>
            <ActionButton onClick={handleReject} variant="danger" disabled={reject.isPending}>
              Reject
            </ActionButton>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ── Account drawer ────────────────────────────────────────────────────

export function AccountCandidateDrawer({
  candidate, onClose,
}: {
  candidate: AccountCandidate | null;
  onClose: () => void;
}) {
  const open = !!candidate;
  const detailQ = useAccountCandidateDetail(candidate?.id ?? null);
  const track = useAccountCandidateSimple("track");
  const reject = useAccountCandidateSimple("reject");
  const promote = usePromoteAccountToSf();
  const tag = useTagAccountToExisting();

  const d = detailQ.data;
  const title = d?.display_name ?? candidate?.display_name ?? candidate?.primary_domain ?? "Candidate";
  const subtitle = d?.primary_domain ?? candidate?.primary_domain;

  const handlePromoteFresh = () => {
    if (!candidate || !d) return;
    const name = window.prompt("Create new SF Account with name:", d.display_name ?? d.primary_domain);
    if (!name) return;
    promote.mutate({ id: candidate.id, sf_account_name: name }, { onSuccess: onClose });
  };

  const handleTagToSuggestion = () => {
    if (!candidate || !d?.sf_account_suggestion) return;
    tag.mutate(
      {
        id: candidate.id,
        sf_account_id: d.sf_account_suggestion.sf_account_id,
        sf_account_name: d.sf_account_suggestion.sf_account_name ?? undefined,
      },
      { onSuccess: onClose },
    );
  };

  const handleTagManual = () => {
    if (!candidate) return;
    const sfId = window.prompt("Existing SF Account Id (18-char):");
    if (!sfId) return;
    const nm = window.prompt("(optional) SF Account Name", "") || undefined;
    tag.mutate({ id: candidate.id, sf_account_id: sfId.trim(), sf_account_name: nm },
      { onSuccess: onClose });
  };

  const handleReject = () => {
    if (!candidate) return;
    const notes = window.prompt("Reason (optional):", "") || undefined;
    reject.mutate({ id: candidate.id, notes }, { onSuccess: onClose });
  };

  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle}>
      {!d ? (
        <div className="p-6 text-text-muted">{detailQ.isError ? "Failed to load." : "Loading…"}</div>
      ) : (
        <div className="space-y-5 p-4">
          <SignalRow
            signals={d.signal_count}
            unique={d.unique_people}
            firstSeen={d.first_seen_at}
            lastSeen={d.last_seen_at}
            status={d.status}
          />

          {/* SF Account context */}
          {d.sf_account_id ? (
            <Card title="Linked SF Account">
              <div className="text-sm">{d.sf_account_suggestion?.sf_account_name ?? d.sf_account_id}</div>
              <div className="text-xs text-text-muted">{d.sf_account_id}</div>
            </Card>
          ) : d.sf_account_suggestion ? (
            <Card title="Suggested SF Account (from domain map)" tone="info">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">{d.sf_account_suggestion.sf_account_name ?? "Untitled"}</div>
                  <div className="text-xs text-text-muted">{d.sf_account_suggestion.sf_account_id}</div>
                </div>
                <ActionButton onClick={handleTagToSuggestion} variant="primary" disabled={tag.isPending}>
                  Tag to this
                </ActionButton>
              </div>
            </Card>
          ) : null}

          {/* public.companies enrichment */}
          {d.public_company && (
            <Card title="Pursuit registry match" icon={<User className="h-3.5 w-3.5" />}>
              <div className="flex items-center gap-3">
                {d.public_company.logo_url && (
                  <img src={d.public_company.logo_url} alt="" className="h-10 w-10 rounded" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{d.public_company.name ?? "—"}</div>
                  <div className="text-xs text-text-muted">
                    {[d.public_company.industry, d.public_company.size_bucket, d.public_company.hq_location]
                      .filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Internal counterparts */}
          {d.internal_counterparts.length > 0 && (
            <Card title="Internal contacts at this firm" icon={<Users className="h-3.5 w-3.5" />}>
              <ul className="space-y-1">
                {d.internal_counterparts.map((c) => (
                  <li key={c.email} className="flex items-center justify-between text-sm">
                    <span>{c.display_name}</span>
                    <span className="text-text-muted text-xs">{c.interaction_count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Top people at this domain */}
          {d.top_people.length > 0 && (
            <Card
              title={`People at this domain (${d.top_people.length})`}
              subtitle="Promote them individually from the People tab"
            >
              <ul className="space-y-1">
                {d.top_people.map((p) => (
                  <li key={p.id} className="flex items-center justify-between text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{p.display_name ?? p.email}</div>
                      <div className="text-xs text-text-muted truncate">{p.email}</div>
                    </div>
                    <span className="shrink-0 text-text-muted text-xs">{p.signal_count} sig</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Catch-all actions */}
          <div className="sticky bottom-0 -mx-4 mt-3 flex flex-wrap gap-2 border-t border-border-subtle bg-surface p-3">
            {!d.sf_account_id && (
              <ActionButton onClick={handlePromoteFresh} variant="primary" disabled={promote.isPending}>
                Open as new SF Account
              </ActionButton>
            )}
            <ActionButton onClick={handleTagManual} disabled={tag.isPending}>
              Tag by SF Account Id…
            </ActionButton>
            <ActionButton
              onClick={() => candidate && track.mutate({ id: candidate.id }, { onSuccess: onClose })}
              disabled={track.isPending}
            >
              Track only
            </ActionButton>
            <ActionButton onClick={handleReject} variant="danger" disabled={reject.isPending}>
              Reject
            </ActionButton>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────

function SignalRow({
  signals, unique, firstSeen, lastSeen, status,
}: {
  signals: number; unique?: number; firstSeen: string | null; lastSeen: string | null; status: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
      <span>{signals} signal{signals === 1 ? "" : "s"}</span>
      {unique != null && <span>· {unique} people</span>}
      <span>· first {fmtDate(firstSeen)}</span>
      <span>· last {fmtDate(lastSeen)}</span>
      <span className="ml-auto rounded bg-surface-muted px-1.5 py-0.5 uppercase tracking-wide">
        {status.replace("_", " ")}
      </span>
    </div>
  );
}

function Card({
  title, subtitle, icon, tone, children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "info" | "default";
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-md border p-3 ${
        tone === "info" ? "border-info/40 bg-info/5" : "border-border-strong bg-surface"
      }`}
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {icon}
        {title}
      </div>
      {subtitle && <div className="mb-2 text-xs text-text-muted">{subtitle}</div>}
      {children}
    </section>
  );
}

function PublicContactRow({
  match, exact, onTag, busy,
}: {
  match: PublicContactMatch;
  exact?: boolean;
  onTag: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border-subtle bg-surface px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{match.full_name ?? match.email ?? "—"}</span>
          {exact && <span className="rounded bg-success/20 px-1 text-[10px] uppercase text-success">EXACT</span>}
          {match.linkedin_url && (
            <a
              href={match.linkedin_url}
              target="_blank" rel="noreferrer"
              className="text-info hover:text-info"
              onClick={(e) => e.stopPropagation()}
              title="Open LinkedIn"
            >
              <Linkedin className="h-3.5 w-3.5" />
            </a>
          )}
          {match.sf_contact_id && (
            <span className="rounded bg-info/10 px-1 text-[10px] uppercase text-info">SF</span>
          )}
        </div>
        <div className="truncate text-xs text-text-muted">
          {[match.current_title, match.current_company].filter(Boolean).join(" · ")}
          {match.email && match.full_name && <> · {match.email}</>}
        </div>
      </div>
      <button
        type="button"
        onClick={onTag}
        disabled={busy}
        className="shrink-0 rounded border border-accent bg-accent px-2 py-1 text-xs text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
      >
        {match.sf_contact_id ? "Tag to this" : "Open as SF"}
      </button>
    </div>
  );
}

function ActionButton({
  children, onClick, disabled, variant,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger";
}) {
  const styles = variant === "primary"
    ? "border-accent bg-accent text-accent-foreground hover:bg-accent/90"
    : variant === "danger"
    ? "border-error text-error hover:bg-error/10"
    : "border-border-strong bg-surface hover:bg-surface-muted";
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className={`rounded border px-2.5 py-1.5 text-xs ${styles} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); }
  catch { return iso.slice(0, 10); }
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return iso.slice(0, 16); }
}
