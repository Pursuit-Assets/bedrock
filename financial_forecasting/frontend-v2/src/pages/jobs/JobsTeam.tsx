import { Fragment, useState } from "react";
import {
  useJobsOpportunities,
  useJobsOpportunity,
  useUpdateOpportunity,
  useCreateOpportunity,
  useLogActivity,
  useDeleteActivity,
  useBuilders,
  useContactSearch,
  useOppPlacements,
  useUnlinkedPlacements,
  useCreatePlacement,
  useLinkPlacement,
  useStaff,
  type Staff,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  ACTIVE_STAGES,
  STAGES_ORDERED,
  type JobStage,
  type DealType,
  type JobsOpportunity,
  type JobContact,
  type ActivityCreateBody,
  type Builder,
  type ContactSearchResult,
  type OppPlacement,
} from "@/services/jobs";
import { JobStageChip, DealTypeChip } from "@/components/jobs/JobStageChip";
import { InlineText, InlineDate } from "@/components/ui/InlineEdit";
import { ChevronDown, ChevronRight, Building2, Users, Activity, Clock, Mail, Linkedin, Trash2, X, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

// ── Owner config ─────────────────────────────────────────────────────────────

interface OwnerDef {
  label: string;
  email: string;
  initials: string;
  color: string;
}

const OWNERS: OwnerDef[] = [
  { label: "Avni",   email: "avni@pursuit.org",             initials: "A",  color: "bg-violet-100 text-violet-700" },
  { label: "Damon",  email: "damon.kornhauser@pursuit.org", initials: "D",  color: "bg-sky-100 text-sky-700" },
  { label: "Devika", email: "devika@pursuit.org",           initials: "De", color: "bg-rose-100 text-rose-700" },
];

function ownerLabel(email: string | null): string {
  if (!email) return "—";
  const match = OWNERS.find((o) => o.email === email);
  if (match) return match.label;
  return email.split("@")[0] ?? email;
}

function ownerInitials(email: string | null): string {
  if (!email) return "?";
  const match = OWNERS.find((o) => o.email === email);
  if (match) return match.initials;
  const part = email.split("@")[0] ?? "";
  return part.slice(0, 2).toUpperCase();
}

function ownerColor(email: string | null): string {
  const match = OWNERS.find((o) => o.email === email);
  return match?.color ?? "bg-stone-100 text-stone-600";
}

// ── Stage group filter ────────────────────────────────────────────────────────

type StageGroup = "all" | "active" | "on_hold" | "closed";

const STAGE_GROUP_LABELS: Record<StageGroup, string> = {
  all:     "All",
  active:  "Active",
  on_hold: "On Hold",
  closed:  "Closed",
};

function stageMatchesGroup(stage: JobStage, group: StageGroup): boolean {
  if (group === "all") return true;
  if (group === "active") return ACTIVE_STAGES.includes(stage) || stage === "lead_submitted" || stage === "initial_outreach";
  if (group === "on_hold") return stage.startsWith("on_hold");
  if (group === "closed") return stage.startsWith("closed");
  return true;
}

// ── Stage dropdown color ──────────────────────────────────────────────────────

const STAGE_SELECT_STYLES: Record<JobStage, string> = {
  lead_submitted:               "text-stone-600",
  initial_outreach:             "text-blue-700",
  active_in_discussions:        "text-amber-700",
  active_opportunity_confirmed: "text-emerald-700",
  active_builder_interview:     "text-emerald-800 font-semibold",
  closed_won:                   "text-green-800 font-semibold",
  closed_lost:                  "text-red-600",
  on_hold_not_selected:         "text-stone-500",
  on_hold_not_interested:       "text-stone-500",
  on_hold_not_responsive:       "text-stone-500",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OwnerAvatar({ email, size = "sm" }: { email: string | null; size?: "sm" | "md" }) {
  const sz = size === "sm" ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold leading-none",
        sz,
        ownerColor(email),
      )}
      title={ownerLabel(email)}
    >
      {ownerInitials(email)}
    </span>
  );
}

function CountBadge({
  count,
  icon: Icon,
  title,
}: {
  count: number;
  icon: React.ElementType;
  title: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3"
      title={title}
    >
      <Icon size={11} className="shrink-0" />
      <span className="font-mono tabular-nums">{count}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin text-ink-3"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Builder picker ────────────────────────────────────────────────────────────

function BuilderPicker({
  dealId,
  builderIds,
}: {
  dealId: string;
  builderIds: string[];
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const updateOpp = useUpdateOpportunity();
  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];

  function removeBuilder(email: string) {
    updateOpp.mutate({ id: dealId, builder_ids: builderIds.filter((b) => b !== email) });
  }

  function addBuilder(builder: Builder) {
    if (builderIds.includes(builder.email)) return;
    updateOpp.mutate({ id: dealId, builder_ids: [...builderIds, builder.email] });
    setSearch("");
    setOpen(false);
  }

  const filtered = builders.filter(
    (b) => !builderIds.includes(b.email)
  );

  return (
    <div className="flex flex-col gap-1.5">
      {builderIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {builderIds.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2 border border-border-strong"
            >
              {email}
              <button
                type="button"
                onClick={() => removeBuilder(email)}
                className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                title="Remove builder"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          type="text"
          value={search}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          placeholder="Search builders…"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        {open && filtered.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
            {filtered.slice(0, 12).map((b) => (
              <li key={b.email}>
                <button
                  type="button"
                  onMouseDown={() => addBuilder(b)}
                  className="w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                >
                  <span className="font-medium">{b.name}</span>
                  <span className="ml-1.5 text-ink-3">{b.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Contact picker ────────────────────────────────────────────────────────────

/** Derive source badge label + style from a sf_contact_ids ref string */
function contactRefSource(ref: string): { label: string; className: string } {
  if (ref.startsWith("airtable:")) return { label: "Jobs", className: "bg-accent-soft text-accent-ink" };
  if (ref.startsWith("pub:"))      return { label: "LinkedIn", className: "bg-indigo-50 text-indigo-600" };
  return { label: "SF", className: "bg-sky-50 text-sky-600" };
}

/** Derive source badge label + style from a ContactSearchResult */
function searchResultSource(c: ContactSearchResult): { label: string; className: string } {
  if (c.airtable_id)                   return { label: "Jobs",     className: "bg-accent-soft text-accent-ink" };
  if (c.in_sf)                          return { label: "SF",       className: "bg-sky-50 text-sky-600" };
  if (c.source === "linkedin_import")   return { label: "LinkedIn", className: "bg-indigo-50 text-indigo-600" };
  return { label: "Jobs", className: "bg-accent-soft text-accent-ink" };
}

function ContactSourceBadge({ className, label }: { className: string; label: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1 py-0.5 text-[9.5px] font-semibold leading-none", className)}>
      {label}
    </span>
  );
}

function ContactPicker({
  dealId,
  sfContactIds,
  linkedContacts,
}: {
  dealId: string;
  sfContactIds: string[];
  linkedContacts: JobContact[];
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const updateOpp = useUpdateOpportunity();
  const searchQ = useContactSearch(search);
  const results: ContactSearchResult[] = search.length >= 2 ? (searchQ.data ?? []) : [];

  function contactDisplayName(c: JobContact): string {
    return c.full_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || `#${c.contact_id}`);
  }

  /** Find the ref stored in sfContactIds that corresponds to this linked contact */
  function findRef(c: JobContact): string {
    return (
      sfContactIds.find(
        (id) =>
          id === `airtable:${c.contact_id}` ||
          id === `pub:${c.contact_id}` ||
          id.endsWith(`:${c.contact_id}`)
      ) ?? String(c.contact_id)
    );
  }

  function removeContact(ref: string) {
    updateOpp.mutate({ id: dealId, sf_contact_ids: sfContactIds.filter((x) => x !== ref) });
  }

  function addContact(result: ContactSearchResult) {
    if (sfContactIds.includes(result.contact_ref)) return;
    updateOpp.mutate({ id: dealId, sf_contact_ids: [...sfContactIds, result.contact_ref] });
    setSearch("");
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* Current linked contacts as pills */}
      {linkedContacts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {linkedContacts.map((c) => {
            const ref = findRef(c);
            const badge = contactRefSource(ref);
            return (
              <span
                key={c.contact_id}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2 border border-border-strong"
                title={c.email ?? undefined}
              >
                {contactDisplayName(c)}
                <ContactSourceBadge label={badge.label} className={badge.className} />
                <button
                  type="button"
                  onClick={() => removeContact(ref)}
                  className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                  title="Remove contact"
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onFocus={() => { if (search.length >= 2) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          placeholder="Search all 32k+ contacts…"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        {open && search.length >= 2 && (
          <ul className="absolute z-20 mt-1 max-h-[160px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
            {searchQ.isLoading ? (
              <li className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-ink-3">
                <Spinner /> Searching…
              </li>
            ) : results.length === 0 ? (
              <li className="px-3 py-2 text-[11.5px] text-ink-4">No contacts found.</li>
            ) : (
              results.slice(0, 12).map((r) => {
                const badge = searchResultSource(r);
                const titleLine = [r.current_title, r.current_company].filter(Boolean).join(" @ ");
                return (
                  <li key={r.contact_id}>
                    <button
                      type="button"
                      onMouseDown={() => addContact(r)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{r.full_name ?? `#${r.contact_id}`}</span>
                        {titleLine ? (
                          <span className="ml-1.5 text-ink-3">{titleLine}</span>
                        ) : null}
                      </span>
                      <ContactSourceBadge label={badge.label} className={badge.className} />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      {/* Footer hints */}
      <p className="text-[10.5px] text-ink-4">
        Contacts from SF, LinkedIn, and Jobs pipeline — all 32k+ contacts searchable
      </p>
      <p className="text-[10.5px] text-ink-4">
        Can't find them? Use the Contacts tab to create a new one.
      </p>
    </div>
  );
}

// ── Staff (owner) picker ──────────────────────────────────────────────────────

function StaffPicker({
  value,
  onChange,
}: {
  value: string | null;
  /** Returns a promise that resolves once the save has persisted. */
  onChange: (email: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // useStaff() with no arg returns up to 50 active staff; filter client-side for snappiness.
  const staffQ = useStaff();
  const staff = staffQ.data ?? [];

  const q = search.trim().toLowerCase();
  const filtered: Staff[] = q
    ? staff.filter(
        (s) =>
          s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q),
      )
    : staff;

  // Display label for the current owner: staff name if resolvable, else raw email, else Unassigned.
  const current = value ? staff.find((s) => s.email === value) : undefined;
  const displayLabel = current?.name ?? (value || "Unassigned");

  async function select(email: string | null) {
    setSaving(true);
    try {
      await onChange(email);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1200);
    } finally {
      setSaving(false);
      setOpen(false);
      setSearch("");
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-ink-2 hover:bg-surface-2"
      >
        <span className={cn(value ? "text-ink-2" : "text-ink-4")}>{displayLabel}</span>
        {saving ? (
          <Spinner />
        ) : savedTick ? (
          <Check size={12} className="text-emerald-600" />
        ) : (
          <ChevronDown size={12} className="text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-full min-w-[180px] overflow-auto rounded border border-border-strong bg-surface shadow">
          <div className="sticky top-0 bg-surface px-2 pt-2 pb-1">
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Search staff…"
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
          <div
            onMouseDown={(e) => e.preventDefault()}
            className="px-3 py-1.5 text-[12px] italic text-ink-4 hover:bg-surface-2 cursor-pointer"
            onClick={() => void select(null)}
          >
            Unassign
          </div>
          {staffQ.isLoading ? (
            <div className="px-3 py-1.5 text-[12px] text-ink-4">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-1.5 text-[12px] text-ink-4">No staff found.</div>
          ) : (
            filtered.map((s) => (
              <div
                key={s.email}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void select(s.email)}
                className={cn(
                  "px-3 py-1.5 text-[12px] hover:bg-surface-2 cursor-pointer",
                  s.email === value ? "font-medium text-ink" : "text-ink-2",
                )}
              >
                <span>{s.name}</span>
                <span className="ml-1.5 text-ink-4">{s.email}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Expanded detail panel ────────────────────────────────────────────────────

function DealDetailPanel({
  deal,
  onRecordPlacements,
}: {
  deal: JobsOpportunity;
  onRecordPlacements: (deal: { id: string; account_name: string }) => void;
}) {
  const [activeTab, setActiveTab] = useState<"activity" | "history" | "contacts">("activity");
  const detailQ = useJobsOpportunity(deal.id);
  const updateOpp = useUpdateOpportunity();

  const detail = detailQ.data;
  const isPending = updateOpp.isPending;

  // Only full-time / part-time-contract wins produce job placements.
  // Capstone, volunteer, workshop, pilot wins are outcomes but not secured jobs.
  const isPlacementType = deal.deal_type === "ft" || deal.deal_type === "pt_contract";

  function handleStageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newStage = e.target.value as JobStage;
    if (newStage === deal.stage) return;
    updateOpp.mutate(
      { id: deal.id, stage: newStage },
      {
        onSuccess: () => {
          if (newStage === "closed_won" && isPlacementType) {
            onRecordPlacements({ id: deal.id, account_name: deal.account_name });
          }
        },
      },
    );
  }

  function handleDealTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    updateOpp.mutate({ id: deal.id, deal_type: val === "" ? null : val });
  }

  function patch(fields: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      updateOpp.mutate({ id: deal.id, ...fields }, { onSuccess: () => resolve(), onError: reject });
    });
  }

  // Contacts summary from detail
  const contacts = detail?.contacts ?? [];

  return (
    <div
      className="grid min-h-[280px] grid-cols-[1fr_340px] border-t border-border-strong bg-surface"
      style={{ boxShadow: "0 2px 8px rgba(20,18,14,0.04) inset" }}
    >
      {/* Left — deal fields */}
      <div className="flex flex-col gap-4 border-r border-border-strong px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Stage selector */}
          <div className="flex items-center gap-1.5">
            {isPending ? <Spinner /> : null}
            <label className="text-[11px] uppercase tracking-wider text-ink-3">Stage</label>
          </div>
          <select
            value={deal.stage}
            onChange={handleStageChange}
            disabled={isPending}
            className={cn(
              "rounded border border-border-strong bg-surface px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60",
              STAGE_SELECT_STYLES[deal.stage],
            )}
          >
            {STAGES_ORDERED.map((s) => (
              <option key={s} value={s} className={STAGE_SELECT_STYLES[s]}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>

          {deal.stage === "closed_won" && isPlacementType && (
            <button
              type="button"
              onClick={() => onRecordPlacements({ id: deal.id, account_name: deal.account_name })}
              className="flex items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              <Users size={12} />
              Record placements
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Role Title" className="col-span-2">
            <InlineText
              value={deal.title}
              placeholder="Add role title…"
              onSave={(v) => patch({ title: v || null })}
            />
          </Field>

          <Field label="Deal Type">
            <select
              value={deal.deal_type ?? ""}
              onChange={handleDealTypeChange}
              disabled={isPending}
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60"
            >
              <option value="">— none —</option>
              {(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>

          <Field label="Owner">
            <StaffPicker
              value={deal.owner_email}
              onChange={(email) => patch({ owner_email: email })}
            />
          </Field>

          <Field label="Follow-up Date">
            <InlineDate
              value={deal.follow_up_date}
              onSave={(v) => patch({ follow_up_date: v })}
              variant="long"
            />
          </Field>

          <Field label="Expected Salary $">
            <InlineText
              value={deal.salary_expected != null ? String(deal.salary_expected) : ""}
              placeholder="—"
              formatDisplay={(raw) => {
                const n = Number(raw.replace(/[^0-9.]/g, ""));
                return isNaN(n) ? raw : `$${n.toLocaleString("en-US")}`;
              }}
              onSave={(v) => {
                const n = v === "" ? null : Number(v.replace(/[^0-9.]/g, ""));
                return patch({ salary_expected: n === null || isNaN(n) ? null : n });
              }}
            />
          </Field>

          <Field label="Touch Count">
            <InlineText
              value={deal.touch_count > 0 ? String(deal.touch_count) : ""}
              placeholder="0"
              onSave={(v) => {
                const n = v === "" ? 0 : parseInt(v, 10);
                return patch({ touch_count: isNaN(n) ? 0 : n });
              }}
            />
          </Field>

          <Field label="Builders" className="col-span-2">
            <BuilderPicker dealId={deal.id} builderIds={deal.builder_ids} />
          </Field>

          <Field label="Contacts" className="col-span-2">
            {detailQ.isLoading ? (
              <span className="text-[12px] text-ink-4">Loading…</span>
            ) : (
              <ContactPicker
                dealId={deal.id}
                sfContactIds={deal.sf_contact_ids}
                linkedContacts={contacts}
              />
            )}
          </Field>

          <Field label="Description / Notes" className="col-span-2">
            <InlineText
              value={deal.description}
              placeholder="Add notes…"
              multiline
              onSave={(v) => patch({ description: v || null })}
            />
          </Field>
        </div>
      </div>

      {/* Right — tabs */}
      <div className="flex flex-col">
        <div className="flex border-b border-border-strong bg-surface px-3 pt-2">
          {(["activity", "history", "contacts"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "border-b-2 px-3 pb-1.5 pt-1 text-[12px] font-medium transition-colors",
                activeTab === tab
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2",
              )}
            >
              {tab === "activity" && "Activity"}
              {tab === "history" && "History"}
              {tab === "contacts" && (
                <>
                  Contacts
                  {(detail?.contacts?.length ?? 0) > 0 && (
                    <span className="ml-1 text-[10.5px] text-ink-4">
                      ({detail!.contacts.length})
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto">
          {detailQ.isLoading ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-ink-3">
              Loading…
            </div>
          ) : activeTab === "activity" ? (
            <>
              <ActivityTab entries={detail?.activity ?? []} />
              <LogActivityForm dealId={deal.id} />
            </>
          ) : activeTab === "history" ? (
            <HistoryTab entries={detail?.stage_history ?? []} />
          ) : (
            <ContactsTab contacts={detail?.contacts ?? []} />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ── Log Activity inline form ──────────────────────────────────────────────────

type ActivityType = ActivityCreateBody["type"];

const ACTIVITY_TYPES: { value: ActivityType; label: string }[] = [
  { value: "email",   label: "Email" },
  { value: "call",    label: "Call" },
  { value: "meeting", label: "Meeting" },
  { value: "note",    label: "Note" },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function LogActivityForm({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType]   = useState<ActivityType>("email");
  const [date, setDate]   = useState(todayIso);
  const [desc, setDesc]   = useState("");

  const logActivity = useLogActivity();

  function reset() {
    setType("email");
    setDate(todayIso());
    setDesc("");
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!desc.trim()) return;
    await logActivity.mutateAsync({
      jobs_opportunity_id: dealId,
      type,
      description: desc.trim(),
      activity_date: date || todayIso(),
    });
    reset();
  }

  if (!open) {
    return (
      <div className="border-t border-border-strong px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12px] text-accent hover:underline"
        >
          + Log Activity
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="border-t border-border-strong px-4 py-3 flex flex-col gap-2"
    >
      {/* Type selector — button group */}
      <div className="flex gap-1">
        {ACTIVITY_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            className={cn(
              "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
              type === t.value
                ? "border-accent bg-accent/5 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Date */}
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />

      {/* Description */}
      <textarea
        rows={3}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="What happened?"
        className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={logActivity.isPending || !desc.trim()}
          className="rounded bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {logActivity.isPending ? "Logging…" : "Log"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-[12px] text-ink-3 hover:text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ActivitySourceBadge({ entry }: { entry: import("@/services/jobs").ActivityEntry }) {
  if (entry.is_jobs) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent-soft text-accent-ink">
        Jobs
      </span>
    );
  }
  if (entry.source === "gmail-sync") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-600">
        Gmail
      </span>
    );
  }
  if (entry.source === "calendar-sync") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-50 text-violet-600">
        Calendar
      </span>
    );
  }
  if (entry.source === "salesforce") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-50 text-sky-600">
        SF
      </span>
    );
  }
  // manual and not is_jobs
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-stone-100 text-stone-500">
      Manual
    </span>
  );
}

function ActivityTab({
  entries,
}: {
  entries: import("@/services/jobs").ActivityEntry[];
}) {
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null);
  const deleteActivity = useDeleteActivity();

  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No activity recorded yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {entries.map((e) => {
        const isExpanded = expandedActivityId === e.id;
        return (
          <li
            key={e.id}
            className="cursor-pointer px-4 py-2.5 hover:bg-surface-2/40 transition-colors"
            onClick={() => setExpandedActivityId(isExpanded ? null : e.id)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-[12px] font-medium text-ink">
                  {e.subject ?? e.type ?? "Activity"}
                </span>
                {!isExpanded && e.description ? (
                  <span className="text-[11.5px] text-ink-3 line-clamp-2">{e.description}</span>
                ) : null}
                {e.logged_by ? (
                  <span className="text-[10.5px] text-ink-4">by {e.logged_by}</span>
                ) : null}
                {isExpanded && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    {e.description ? (
                      <p className="text-[11.5px] text-ink-2 whitespace-pre-wrap">{e.description}</p>
                    ) : null}
                    {e.email_from ? (
                      <span className="text-[11px] text-ink-3">
                        <span className="font-medium">From:</span> {e.email_from}
                      </span>
                    ) : null}
                    {e.meeting_duration_minutes != null ? (
                      <span className="text-[11px] text-ink-3">
                        <span className="font-medium">Duration:</span> {e.meeting_duration_minutes} min
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <ActivitySourceBadge entry={e} />
                <span className="font-mono text-[10.5px] text-ink-4">
                  {e.activity_date ? format(new Date(e.activity_date), "MMM d") : "—"}
                </span>
                {e.is_jobs ? (
                  <button
                    type="button"
                    title="Delete activity"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      deleteActivity.mutate(e.id);
                    }}
                    className="text-ink-4 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function HistoryTab({
  entries,
}: {
  entries: import("@/services/jobs").StageHistoryEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No stage changes recorded yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {entries.map((e) => (
        <li key={e.id} className="px-4 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                {e.from_stage ? (
                  <>
                    <span className="text-ink-3">{STAGE_LABELS[e.from_stage]}</span>
                    <span className="text-ink-4">→</span>
                  </>
                ) : null}
                <span className="font-medium text-ink">{STAGE_LABELS[e.to_stage]}</span>
              </div>
              {e.note ? (
                <span className="text-[11px] text-ink-3 italic">{e.note}</span>
              ) : null}
              {e.changed_by ? (
                <span className="text-[10.5px] text-ink-4">by {e.changed_by}</span>
              ) : null}
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-4">
              {format(new Date(e.changed_at), "MMM d")}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Contact stage pill ────────────────────────────────────────────────────────

const CONTACT_STAGE_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  active:           { label: "Active",           className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Initial Outreach", className: "bg-accent-soft text-accent-ink" },
  lead:             { label: "Lead",             className: "bg-stone-100 text-stone-500" },
  on_hold:          { label: "On Hold",          className: "bg-amber-50 text-amber-600" },
};

function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return null;
  const style = CONTACT_STAGE_STYLES[stage];
  if (!style) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function contactInitials(contact: JobContact): string {
  if (contact.first_name && contact.last_name) {
    return (contact.first_name[0] + contact.last_name[0]).toUpperCase();
  }
  if (contact.full_name) {
    const parts = contact.full_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
    }
    return contact.full_name.slice(0, 2).toUpperCase();
  }
  return "??";
}

function ContactsTab({ contacts }: { contacts: JobContact[] }) {
  if (contacts.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No contacts linked to this deal.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {contacts.map((c) => (
        <li key={c.contact_id} className="flex items-center gap-3 px-4 py-2.5">
          {/* Initials avatar */}
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold leading-none text-accent-ink">
            {contactInitials(c)}
          </span>

          {/* Middle — name / title / stage */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-semibold text-ink">
              {c.full_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "—")}
            </span>
            {(c.current_title || c.current_company) ? (
              <span className="truncate text-[12px] text-ink-3">
                {[c.current_title, c.current_company].filter(Boolean).join(" @ ")}
              </span>
            ) : null}
            <ContactStagePill stage={c.contact_stage} />
          </div>

          {/* Right — email + LinkedIn */}
          <div className="flex shrink-0 items-center gap-2">
            {c.email ? (
              <a
                href={`mailto:${c.email}`}
                title={c.email}
                className="text-ink-3 transition-colors hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                <Mail size={14} />
              </a>
            ) : null}
            {c.linkedin_url ? (
              <a
                href={c.linkedin_url}
                target="_blank"
                rel="noreferrer"
                title="LinkedIn"
                className="text-ink-3 transition-colors hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                <Linkedin size={14} />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Deal row ──────────────────────────────────────────────────────────────────

function DealRow({
  deal,
  isExpanded,
  onToggle,
  onRecordPlacements,
}: {
  deal: JobsOpportunity;
  isExpanded: boolean;
  onToggle: () => void;
  onRecordPlacements: (deal: { id: string; account_name: string }) => void;
}) {
  return (
    <Fragment>
      <tr
        className={cn(
          "h-[44px] cursor-pointer border-t border-border-strong transition-colors",
          isExpanded ? "bg-surface-2/60" : "hover:bg-surface-2/40",
        )}
        onClick={onToggle}
      >
        {/* Chevron */}
        <td className="w-7 px-2 align-middle">
          {isExpanded ? (
            <ChevronDown size={13} className="text-ink-4" />
          ) : (
            <ChevronRight size={13} className="text-ink-4" />
          )}
        </td>

        {/* Company */}
        <td className="px-3 align-middle">
          <div className="flex items-center gap-2">
            <Building2 size={13} className="shrink-0 text-ink-4" />
            <span className="truncate text-[14px] font-semibold text-ink">
              {deal.account_name}
            </span>
          </div>
        </td>

        {/* Stage chip */}
        <td className="w-[170px] px-3 align-middle">
          <JobStageChip stage={deal.stage} />
        </td>

        {/* Deal type chip */}
        <td className="w-[110px] px-3 align-middle">
          {deal.deal_type ? (
            <DealTypeChip type={deal.deal_type} />
          ) : (
            <span className="text-[11px] text-ink-4">—</span>
          )}
        </td>

        {/* Owner avatar */}
        <td className="w-[48px] px-3 align-middle">
          <OwnerAvatar email={deal.owner_email} />
        </td>

        {/* Badges */}
        <td className="w-[120px] px-1 align-middle">
          <div className="flex items-center">
            {deal.builder_ids.length > 0 ? (
              <CountBadge count={deal.builder_ids.length} icon={Users} title="Builders" />
            ) : null}
            {(deal.activity_count ?? 0) > 0 ? (
              <CountBadge count={deal.activity_count!} icon={Activity} title="Activities" />
            ) : null}
            {deal.touch_count > 0 ? (
              <CountBadge count={deal.touch_count} icon={Clock} title="Touches" />
            ) : null}
          </div>
        </td>

        {/* Updated */}
        <td className="w-[120px] px-3 align-middle text-right">
          <span className="font-mono text-[11px] text-ink-4" title={fmtShortDate(deal.updated_at)}>
            {fmtRelative(deal.updated_at)}
          </span>
        </td>
      </tr>

      {isExpanded ? (
        <tr>
          <td colSpan={7} className="p-0">
            <DealDetailPanel deal={deal} onRecordPlacements={onRecordPlacements} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

// ── New Deal modal ────────────────────────────────────────────────────────────

interface NewDealForm {
  companyName: string;
  stage: JobStage;
  dealType: DealType | "";
  roleTitle: string;
  owner: string;
  expectedSalary: string;
  notes: string;
}

const DEFAULT_NEW_DEAL_FORM: NewDealForm = {
  companyName: "",
  stage: "lead_submitted",
  dealType: "",
  roleTitle: "",
  owner: "",
  expectedSalary: "",
  notes: "",
};

function NewDealModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<NewDealForm>(DEFAULT_NEW_DEAL_FORM);
  const createOpportunity = useCreateOpportunity();

  function set<K extends keyof NewDealForm>(key: K, value: NewDealForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.companyName.trim()) return;

    const salary = form.expectedSalary.trim()
      ? Number(form.expectedSalary.replace(/[^0-9.]/g, ""))
      : undefined;

    await createOpportunity.mutateAsync({
      account_id: "UNKNOWN",
      account_name: form.companyName.trim(),
      stage: form.stage,
      deal_type: form.dealType || null,
      title: form.roleTitle.trim() || undefined,
      owner_email: form.owner.trim() || undefined,
      salary_expected: salary != null && !isNaN(salary) ? salary : undefined,
      description: form.notes.trim() || undefined,
    } as Partial<JobsOpportunity>);

    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">New Deal</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          {/* Company Name */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Company Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.companyName}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder="Acme Corp"
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {/* Stage */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Stage <span className="text-red-500">*</span>
            </label>
            <select
              value={form.stage}
              onChange={(e) => set("stage", e.target.value as JobStage)}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {STAGES_ORDERED.map((s) => (
                <option key={s} value={s}>{STAGE_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* Deal Type + Role Title (two columns) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Deal Type</label>
              <select
                value={form.dealType}
                onChange={(e) => set("dealType", e.target.value as DealType | "")}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="">— none —</option>
                {(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Role Title</label>
              <input
                type="text"
                value={form.roleTitle}
                onChange={(e) => set("roleTitle", e.target.value)}
                placeholder="Software Engineer"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </div>

          {/* Owner + Expected Salary (two columns) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Owner</label>
              <input
                type="text"
                value={form.owner}
                onChange={(e) => set("owner", e.target.value)}
                placeholder="avni@pursuit.org"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Expected Salary</label>
              <input
                type="number"
                value={form.expectedSalary}
                onChange={(e) => set("expectedSalary", e.target.value)}
                placeholder="85000"
                min={0}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </div>

          {/* Notes */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Add any initial notes…"
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium text-ink-3 hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createOpportunity.isPending || !form.companyName.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {createOpportunity.isPending ? (
                <Spinner />
              ) : (
                <Plus size={13} />
              )}
              {createOpportunity.isPending ? "Creating…" : "Create Deal"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Record Placements modal ───────────────────────────────────────────────────

const EMPLOYMENT_TYPES: { value: string; label: string }[] = [
  { value: "full_time", label: "Full-Time" },
  { value: "contract",  label: "Contract" },
  { value: "freelance", label: "Freelance" },
  { value: "pro_bono",  label: "Pro Bono" },
];

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  EMPLOYMENT_TYPES.map((t) => [t.value, t.label]),
);

function PlacementsModal({
  deal,
  onClose,
}: {
  deal: { id: string; account_name: string };
  onClose: () => void;
}) {
  const placementsQ = useOppPlacements(deal.id);
  const placements = placementsQ.data ?? [];
  const createPlacement = useCreatePlacement();

  // New placement sub-form
  const [builderSearch, setBuilderSearch] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [roleTitle, setRoleTitle] = useState("");
  const [employmentType, setEmploymentType] = useState("full_time");
  const [salary, setSalary] = useState("");

  const buildersQ = useBuilders(builderSearch || undefined);
  const builderResults = buildersQ.data ?? [];

  // Link-existing section
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState("");
  const unlinkedQ = useUnlinkedPlacements(linkOpen ? linkSearch : "");
  const unlinked = linkOpen ? (unlinkedQ.data ?? []) : [];
  const linkPlacement = useLinkPlacement();

  const linkedIds = new Set(placements.map((p) => p.id));

  function resetSubForm() {
    setBuilder(null);
    setBuilderSearch("");
    setRoleTitle("");
    setEmploymentType("full_time");
    setSalary("");
  }

  function handleAddPlacement(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    createPlacement.mutate(
      {
        oppId: deal.id,
        builder_user_id: builder.user_id,
        builder_name: builder.name,
        role_title: roleTitle.trim() || undefined,
        employment_type: employmentType,
        salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
      },
      { onSuccess: () => resetSubForm() },
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border-strong bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">
            Record Placements for {deal.account_name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
          {/* Currently linked placements */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Linked Placements
            </span>
            {placementsQ.isLoading ? (
              <span className="text-[12px] text-ink-3">Loading…</span>
            ) : placements.length === 0 ? (
              <span className="text-[12px] text-ink-3">No placements recorded yet.</span>
            ) : (
              <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
                {placements.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-ink">{p.builder}</span>
                      <span className="truncate text-[11.5px] text-ink-3">
                        {[p.role_title, EMPLOYMENT_TYPE_LABELS[p.employment_type] ?? p.employment_type]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {p.salary != null ? (
                      <span className="shrink-0 font-mono text-[11.5px] text-ink-3">
                        ${p.salary.toLocaleString("en-US")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a new placement */}
          <form onSubmit={handleAddPlacement} className="flex flex-col gap-3 rounded-md border border-border-strong p-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Add a Placement
            </span>

            {/* Builder picker */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-ink-3">Builder</label>
              {builder ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
                    {builder.name}
                    <button
                      type="button"
                      onClick={() => { setBuilder(null); setBuilderSearch(""); }}
                      className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
                      title="Clear builder"
                    >
                      <X size={11} />
                    </button>
                  </span>
                </div>
              ) : (
                <div className="relative">
                  <input
                    type="text"
                    value={builderSearch}
                    onFocus={() => setBuilderOpen(true)}
                    onBlur={() => setTimeout(() => setBuilderOpen(false), 150)}
                    onChange={(e) => { setBuilderSearch(e.target.value); setBuilderOpen(true); }}
                    placeholder="Search builders…"
                    className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                  />
                  {builderOpen && builderResults.length > 0 && (
                    <ul className="absolute z-20 mt-1 max-h-[160px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
                      {builderResults.slice(0, 12).map((b) => (
                        <li key={b.user_id}>
                          <button
                            type="button"
                            onMouseDown={() => {
                              setBuilder({ user_id: b.user_id, name: b.name });
                              setBuilderOpen(false);
                              setBuilderSearch("");
                            }}
                            className="w-full px-3 py-1.5 text-left text-[12px] text-ink hover:bg-surface-2"
                          >
                            <span className="font-medium">{b.name}</span>
                            <span className="ml-1.5 text-ink-3">{b.email}</span>
                            {b.cohort ? <span className="ml-1.5 text-ink-4">· {b.cohort}</span> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Role title */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-ink-3">Role Title</label>
              <input
                type="text"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                placeholder="Software Engineer"
                className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            {/* Employment type + Salary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-ink-3">Employment Type</label>
                <select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
                >
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-medium text-ink-3">Salary</label>
                <input
                  type="number"
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  placeholder="85000"
                  min={0}
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={!builder || createPlacement.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {createPlacement.isPending ? <Spinner /> : <Plus size={12} />}
                {createPlacement.isPending ? "Adding…" : "Add Placement"}
              </button>
            </div>
          </form>

          {/* Link an existing placement */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setLinkOpen((v) => !v)}
              className="flex items-center gap-1.5 self-start text-[12px] font-medium text-accent hover:underline"
            >
              {linkOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Link existing
            </button>
            {linkOpen && (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  placeholder="Search unlinked placements…"
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                {unlinkedQ.isLoading ? (
                  <span className="text-[12px] text-ink-3">Searching…</span>
                ) : unlinked.length === 0 ? (
                  <span className="text-[12px] text-ink-4">No unlinked placements found.</span>
                ) : (
                  <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
                    {unlinked.map((row: OppPlacement) => (
                      <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-[12.5px] font-medium text-ink">{row.builder}</span>
                          <span className="truncate text-[11px] text-ink-3">
                            {[row.role_title, row.company_name].filter(Boolean).join(" @ ")}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={linkedIds.has(row.id) || linkPlacement.isPending}
                          onClick={() => linkPlacement.mutate({ oppId: deal.id, placementId: row.id })}
                          className="shrink-0 rounded border border-border-strong bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          {linkedIds.has(row.id) ? "Linked" : "Link"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-border-strong px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function JobsTeam() {
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [stageGroup, setStageGroup] = useState<StageGroup>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [placementModalDeal, setPlacementModalDeal] = useState<{ id: string; account_name: string } | null>(null);

  const { data: rawData, isLoading } = useJobsOpportunities(
    ownerFilter ? { owner_email: ownerFilter } : {},
  );

  const allDeals: JobsOpportunity[] = (rawData as { data: JobsOpportunity[]; total: number } | undefined)?.data ?? [];

  const visible = allDeals.filter((d) => stageMatchesGroup(d.stage, stageGroup));

  const stageGroups: StageGroup[] = ["all", "active", "on_hold", "closed"];

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-4 border-b border-border-strong bg-surface px-5 py-2.5">
        {/* Owner pills */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOwnerFilter(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
              ownerFilter === null
                ? "border-accent bg-accent/5 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}
          >
            All
          </button>
          {OWNERS.map((o) => (
            <button
              key={o.email}
              type="button"
              onClick={() => setOwnerFilter(ownerFilter === o.email ? null : o.email)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                ownerFilter === o.email
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-border-strong bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  o.color,
                )}
              >
                {o.initials}
              </span>
              {o.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border-strong" />

        {/* Stage group filter */}
        <div className="flex items-center gap-0.5 rounded-md border border-border-strong bg-surface-2 p-0.5">
          {stageGroups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setStageGroup(g)}
              className={cn(
                "rounded px-2.5 py-1 text-[12px] font-medium transition-colors",
                stageGroup === g
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              {STAGE_GROUP_LABELS[g]}
            </button>
          ))}
        </div>

        {/* Count badge */}
        <span className="ml-auto font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${visible.length} deal${visible.length === 1 ? "" : "s"}`}
        </span>

        {/* New Deal button */}
        <button
          type="button"
          onClick={() => setShowNewDeal(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
        >
          <Plus size={12} />
          New Deal
        </button>
      </div>

      {showNewDeal && (
        <NewDealModal onClose={() => setShowNewDeal(false)} />
      )}

      {placementModalDeal && (
        <PlacementsModal
          deal={placementModalDeal}
          onClose={() => setPlacementModalDeal(null)}
        />
      )}

      {/* Table */}
      {isLoading ? (
        <EmptyState>Loading deals…</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>
          No deals match your filters.{" "}
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            onClick={() => { setOwnerFilter(null); setStageGroup("all"); }}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-7 px-2 py-2" />
              <th className="px-3 py-2 text-left font-semibold">Company</th>
              <th className="w-[170px] px-3 py-2 text-left font-semibold">Stage</th>
              <th className="w-[110px] px-3 py-2 text-left font-semibold">Type</th>
              <th className="w-[48px] px-3 py-2 text-left font-semibold">Owner</th>
              <th className="w-[120px] px-1 py-2 text-left font-semibold">Signals</th>
              <th className="w-[120px] px-3 py-2 text-right font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((deal) => (
              <DealRow
                key={deal.id}
                deal={deal}
                isExpanded={expandedId === deal.id}
                onToggle={() => setExpandedId(expandedId === deal.id ? null : deal.id)}
                onRecordPlacements={setPlacementModalDeal}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center px-6 py-16 text-center text-[13px] text-ink-3">
      {children}
    </div>
  );
}
