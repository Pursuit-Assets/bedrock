import { useState } from "react";
import { Search, Mail, Linkedin, Building2, ChevronRight, ChevronDown, Phone, FileText, Calendar, MessageSquare, Plus } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  useJobsContacts,
  useContactDetail,
  useUpdateContact,
  useLogActivity,
  STAGE_LABELS,
  type JobContactWithDeal,
  type JobStage,
} from "@/services/jobs";
import { InlineText, InlineSelect } from "@/components/ui/InlineEdit";

// ── Constants ────────────────────────────────────────────────────────────────

const CONTACT_STAGE_OPTIONS = [
  { value: "",                 label: "All" },
  { value: "active",           label: "Active" },
  { value: "initial_outreach", label: "Outreach" },
  { value: "lead",             label: "Lead" },
  { value: "on_hold",          label: "On Hold" },
];

const CONTACT_STAGE_STYLES: Record<string, string> = {
  active:           "bg-emerald-50 text-emerald-700",
  initial_outreach: "bg-accent-soft text-accent-ink",
  lead:             "bg-stone-100 text-stone-500",
  on_hold:          "bg-amber-50 text-amber-700",
};

const CONTACT_STAGE_LABELS: Record<string, string> = {
  active:           "Active",
  initial_outreach: "Outreach",
  lead:             "Lead",
  on_hold:          "On Hold",
};

const DEAL_STAGE_STYLES: Record<string, string> = {
  active_in_discussions:        "bg-amber-50 text-amber-700",
  active_opportunity_confirmed: "bg-emerald-50 text-emerald-700",
  active_builder_interview:     "bg-emerald-100 text-emerald-800",
  closed_won:                   "bg-green-100 text-green-800",
  closed_lost:                  "bg-red-50 text-red-600",
  lead_submitted:               "bg-stone-100 text-stone-500",
  initial_outreach:             "bg-blue-50 text-blue-600",
};

const ACTIVITY_ICONS: Record<string, React.ElementType> = {
  email:   Mail,
  call:    Phone,
  meeting: Calendar,
  note:    FileText,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ownerName(email: string | null) {
  if (!email) return null;
  const local = email.split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// ── Activity log form ────────────────────────────────────────────────────────

const ACTIVITY_TYPE_OPTIONS = [
  { value: "email",   label: "Email" },
  { value: "call",    label: "Call" },
  { value: "meeting", label: "Meeting" },
  { value: "note",    label: "Note" },
] as const;

type ActivityType = typeof ACTIVITY_TYPE_OPTIONS[number]["value"];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function LogActivityForm({
  dealId,
  onClose,
}: {
  dealId: string;
  onClose: () => void;
}) {
  const [type, setType] = useState<ActivityType>("email");
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { mutateAsync: logActivity } = useLogActivity();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;
    setSubmitting(true);
    try {
      await logActivity({
        jobs_opportunity_id: dealId,
        type,
        description: description.trim(),
        activity_date: date,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-4 rounded-lg border border-border-strong bg-surface p-3 flex flex-col gap-3">
      {/* Type pills */}
      <div className="flex gap-1.5 flex-wrap">
        {ACTIVITY_TYPE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setType(opt.value)}
            className={cn(
              "px-3 py-1 rounded-full text-[11px] font-medium border transition-colors",
              type === opt.value
                ? "bg-accent text-white border-accent"
                : "bg-surface text-ink-3 border-border-strong hover:border-accent hover:text-accent"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Date */}
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 mb-0.5 block">Date</label>
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="text-[12px] border border-border-strong rounded px-2 py-1 bg-surface text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-4 mb-0.5 block">Description</label>
        <textarea
          rows={3}
          required
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What happened?"
          className="w-full text-[12px] border border-border-strong rounded px-2 py-1.5 bg-surface text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || !description.trim()}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-[12px] font-medium disabled:opacity-50 hover:bg-accent/90 transition-colors"
        >
          {submitting ? "Logging…" : "Log"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-ink-3 hover:text-ink transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Contact expand panel ─────────────────────────────────────────────────────

const CONTACT_STAGE_EDIT_OPTIONS = [
  { value: "active",           label: "Active" },
  { value: "initial_outreach", label: "Outreach" },
  { value: "lead",             label: "Lead" },
  { value: "on_hold",          label: "On Hold" },
] as const;

function ContactDetail({ contactId }: { contactId: number }) {
  const { data, isLoading } = useContactDetail(contactId);
  const { mutateAsync: updateContact } = useUpdateContact();
  const [showLogForm, setShowLogForm] = useState(false);

  if (isLoading) {
    return (
      <div className="px-6 py-5 border-t border-border-strong bg-surface-2 animate-pulse">
        <div className="h-4 bg-surface rounded w-48 mb-3" />
        <div className="h-3 bg-surface rounded w-80" />
      </div>
    );
  }
  if (!data) return null;

  const dealStageStyle = data.deal?.stage
    ? DEAL_STAGE_STYLES[data.deal.stage] ?? "bg-stone-100 text-stone-500"
    : null;

  const save = (field: string) => async (value: string) => {
    await updateContact({ id: contactId, [field]: value });
  };

  return (
    <div className="border-t border-border-strong bg-surface-2">
      <div className="flex gap-6 p-5">
        {/* ── Left: contact info ── */}
        <div className="w-64 flex-shrink-0 flex flex-col gap-4">
          {/* Avatar + name */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-soft flex items-center justify-center text-[13px] font-bold text-accent-ink flex-shrink-0">
              {initials(data.full_name)}
            </div>
            <div className="min-w-0 flex-1">
              <InlineText
                value={data.full_name}
                onSave={save("full_name")}
                placeholder="Full name"
                className="text-[14px] font-semibold text-ink"
              />
              <div className="mt-0.5 px-1.5">
                <InlineSelect
                  value={data.contact_stage ?? undefined}
                  options={CONTACT_STAGE_EDIT_OPTIONS as unknown as { value: string; label: string }[]}
                  onSave={save("contact_stage")}
                  emptyLabel="Set stage"
                  renderValue={(v) =>
                    v ? (
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-medium",
                        CONTACT_STAGE_STYLES[v] ?? "bg-stone-100 text-stone-500")}>
                        {CONTACT_STAGE_LABELS[v] ?? v}
                      </span>
                    ) : (
                      <span className="text-[10px] italic text-ink-4">Set stage</span>
                    )
                  }
                />
              </div>
            </div>
          </div>

          {/* Fields */}
          <div className="flex flex-col gap-2.5 text-[12px]">
            <div>
              <div className="text-ink-4 uppercase tracking-wide text-[10px] font-semibold mb-0.5">Title</div>
              <InlineText
                value={data.current_title}
                onSave={save("current_title")}
                placeholder="Current title"
              />
            </div>
            <div>
              <div className="text-ink-4 uppercase tracking-wide text-[10px] font-semibold mb-0.5">Company</div>
              <InlineText
                value={data.current_company}
                onSave={save("current_company")}
                placeholder="Current company"
              />
            </div>
            <div>
              <div className="text-ink-4 uppercase tracking-wide text-[10px] font-semibold mb-0.5">Email</div>
              <InlineText
                value={data.email}
                onSave={save("email")}
                placeholder="Email address"
              />
            </div>
            <div>
              <div className="text-ink-4 uppercase tracking-wide text-[10px] font-semibold mb-0.5">LinkedIn</div>
              <InlineText
                value={data.linkedin_url}
                onSave={save("linkedin_url")}
                placeholder="LinkedIn URL"
              />
            </div>
            <div>
              <div className="text-ink-4 uppercase tracking-wide text-[10px] font-semibold mb-0.5">Notes</div>
              <InlineText
                value={data.notes}
                onSave={save("notes")}
                placeholder="Add notes…"
                multiline
              />
            </div>
          </div>

          {/* Linked deal */}
          {data.deal && (
            <div className="rounded-lg border border-border-strong bg-surface p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-4 mb-2">Linked Deal</div>
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2 mb-1.5">
                <Building2 size={11} className="text-ink-4 flex-shrink-0" />
                {data.deal.account_name}
              </div>
              {dealStageStyle && (
                <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-medium", dealStageStyle)}>
                  {STAGE_LABELS[data.deal.stage as JobStage] ?? data.deal.stage}
                </span>
              )}
              {data.deal.owner_email && (
                <div className="text-[11px] text-ink-4 mt-1.5">
                  Owner: {ownerName(data.deal.owner_email)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: activity timeline ── */}
        <div className="flex-1 min-w-0">
          {/* Header + Log Activity button */}
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
              Engagement History ({data.activity.length})
            </div>
            {data.deal ? (
              <button
                type="button"
                onClick={() => setShowLogForm(v => !v)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-border-strong bg-surface text-[11px] font-medium text-ink-2 hover:border-accent hover:text-accent transition-colors"
              >
                <Plus size={11} />
                Log Activity
              </button>
            ) : (
              <span className="text-[11px] text-ink-4 italic">
                Link contact to a deal first to log activity.
              </span>
            )}
          </div>

          {/* Inline log form */}
          {showLogForm && data.deal && (
            <LogActivityForm
              dealId={data.deal.id}
              onClose={() => setShowLogForm(false)}
            />
          )}

          {data.activity.length === 0 ? (
            <div className="text-[13px] text-ink-4 italic py-4">
              No engagement history recorded yet.
            </div>
          ) : (
            <div className="flex flex-col gap-0">
              {data.activity.map((act, i) => {
                const Icon = ACTIVITY_ICONS[act.type] ?? MessageSquare;
                const date = act.activity_date ? new Date(act.activity_date) : null;
                return (
                  <div key={act.id} className="flex gap-3 pb-4 relative">
                    {/* Timeline line */}
                    {i < data.activity.length - 1 && (
                      <div className="absolute left-[15px] top-7 bottom-0 w-px bg-border-strong" />
                    )}
                    {/* Icon */}
                    <div className="flex-shrink-0 w-8 h-8 rounded-full border border-border-strong bg-surface flex items-center justify-center z-10">
                      <Icon size={13} className="text-ink-3" />
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0 pt-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[12px] font-medium text-ink capitalize">{act.type}</span>
                        {date && (
                          <span className="text-[11px] text-ink-4" title={format(date, "MMM d, yyyy")}>
                            {formatDistanceToNow(date, { addSuffix: true })}
                          </span>
                        )}
                        {act.logged_by && (
                          <span className="text-[11px] text-ink-4">
                            · {ownerName(act.logged_by)}
                          </span>
                        )}
                      </div>
                      {act.description && (
                        <p className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap">
                          {act.description.length > 300
                            ? act.description.slice(0, 300) + "…"
                            : act.description}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Contact row ───────────────────────────────────────────────────────────────

function ContactRow({
  contact,
  expanded,
  onToggle,
}: {
  contact: JobContactWithDeal;
  expanded: boolean;
  onToggle: () => void;
}) {
  const contactStageStyle = contact.contact_stage
    ? CONTACT_STAGE_STYLES[contact.contact_stage]
    : null;

  const dealStageStyle = contact.deal?.stage
    ? DEAL_STAGE_STYLES[contact.deal.stage] ?? "bg-stone-100 text-stone-500"
    : null;

  const dealLabel = contact.deal?.stage
    ? STAGE_LABELS[contact.deal.stage as JobStage] ?? contact.deal.stage
    : null;

  return (
    <>
      <div
        onClick={onToggle}
        className={cn(
          "flex items-center gap-3 px-4 py-3 border-b border-border-strong last:border-0 cursor-pointer transition-colors",
          expanded ? "bg-surface-2" : "hover:bg-surface-2"
        )}
      >
        {/* Chevron */}
        <div className="flex-shrink-0 text-ink-4">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>

        {/* Avatar */}
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent-soft flex items-center justify-center text-[11px] font-semibold text-accent-ink">
          {initials(contact.full_name)}
        </div>

        {/* Name + stage */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-ink">
              {contact.full_name || "—"}
            </span>
            {contactStageStyle && (
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-medium", contactStageStyle)}>
                {CONTACT_STAGE_LABELS[contact.contact_stage!] ?? contact.contact_stage}
              </span>
            )}
          </div>
          <div className="text-[12px] text-ink-3 truncate mt-0.5">
            {[contact.current_title, contact.current_company].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>

        {/* Linked deal */}
        <div className="flex-shrink-0 min-w-[180px] max-w-[220px] hidden md:block">
          {contact.deal ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[12px] text-ink-2 truncate">
                <Building2 size={11} className="text-ink-4 flex-shrink-0" />
                <span className="truncate">{contact.deal.account_name}</span>
              </div>
              {dealStageStyle && (
                <span className={cn("inline-flex items-center self-start rounded-full px-1.5 py-0.5 text-[10px] leading-4 font-medium", dealStageStyle)}>
                  {dealLabel}
                </span>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-ink-4 italic">No deal linked</span>
          )}
        </div>

        {/* Links — stop propagation so clicks don't toggle row */}
        <div className="flex-shrink-0 flex items-center gap-2" onClick={e => e.stopPropagation()}>
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="text-ink-3 hover:text-accent transition-colors" title={contact.email}>
              <Mail size={14} />
            </a>
          )}
          {contact.linkedin_url && (
            <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer"
              className="text-ink-3 hover:text-accent transition-colors">
              <Linkedin size={14} />
            </a>
          )}
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && <ContactDetail contactId={contact.contact_id} />}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function JobsContacts() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const handleSearch = (val: string) => {
    setSearch(val);
    clearTimeout((handleSearch as any)._t);
    (handleSearch as any)._t = setTimeout(() => setDebouncedSearch(val), 300);
  };

  const { data, isLoading } = useJobsContacts({
    search: debouncedSearch || undefined,
    stage:  stage || undefined,
    limit:  300,
  });

  const contacts  = data?.data ?? [];
  const total     = data?.total ?? 0;
  const withLink  = contacts.filter(c => c.deal);
  const noLink    = contacts.filter(c => !c.deal);

  const toggle = (id: number) => setExpandedId(prev => prev === id ? null : id);

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search name, company, title, email…"
            className="w-full pl-8 pr-3 py-2 text-[13px] border border-border-strong rounded-lg bg-surface focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
          {CONTACT_STAGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setStage(opt.value)}
              className={cn(
                "px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
                stage === opt.value ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-[12px] text-ink-3 ml-auto">
          {isLoading ? "Loading…" : `${total} contacts`}
        </span>
      </div>

      {/* Results */}
      {isLoading ? (
        <div className="rounded-lg border border-border-strong bg-surface divide-y divide-border-strong">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-3 animate-pulse">
              <div className="w-4 h-4 rounded bg-surface-2" />
              <div className="w-7 h-7 rounded-full bg-surface-2" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-surface-2 rounded w-40" />
                <div className="h-2.5 bg-surface-2 rounded w-64" />
              </div>
            </div>
          ))}
        </div>
      ) : contacts.length === 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface px-6 py-12 text-center text-[13px] text-ink-3">
          No contacts match your filters.
        </div>
      ) : (
        <>
          {withLink.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Linked to Deals ({withLink.length})
              </div>
              <div className="rounded-lg border border-border-strong bg-surface overflow-hidden">
                {withLink.map(c => (
                  <ContactRow
                    key={c.contact_id}
                    contact={c}
                    expanded={expandedId === c.contact_id}
                    onToggle={() => toggle(c.contact_id)}
                  />
                ))}
              </div>
            </div>
          )}

          {noLink.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Not Yet Linked ({noLink.length})
              </div>
              <div className="rounded-lg border border-border-strong bg-surface overflow-hidden">
                {noLink.map(c => (
                  <ContactRow
                    key={c.contact_id}
                    contact={c}
                    expanded={expandedId === c.contact_id}
                    onToggle={() => toggle(c.contact_id)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
