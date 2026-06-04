import { useState } from "react";
import { Search, Mail, Linkedin, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useJobsContacts,
  STAGE_LABELS,
  type JobContactWithDeal,
  type JobStage,
} from "@/services/jobs";

const CONTACT_STAGE_OPTIONS = [
  { value: "",                label: "All stages" },
  { value: "active",          label: "Active" },
  { value: "initial_outreach",label: "Initial Outreach" },
  { value: "lead",            label: "Lead — Ready" },
  { value: "on_hold",         label: "On Hold" },
];

const CONTACT_STAGE_STYLES: Record<string, string> = {
  active:           "bg-emerald-50 text-emerald-700",
  initial_outreach: "bg-accent-soft text-accent-ink",
  lead:             "bg-stone-100 text-stone-500",
  on_hold:          "bg-amber-50 text-amber-700",
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

function initials(name: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function ContactRow({ contact }: { contact: JobContactWithDeal }) {
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
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border-strong last:border-0 hover:bg-surface-2 transition-colors">
      {/* Avatar */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center text-[11px] font-semibold text-accent-ink">
        {initials(contact.full_name)}
      </div>

      {/* Name + title + company */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-ink truncate">
            {contact.full_name || "—"}
          </span>
          {contactStageStyle && (
            <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] leading-4 font-medium", contactStageStyle)}>
              {contact.contact_stage === "initial_outreach" ? "Outreach" :
               contact.contact_stage === "on_hold" ? "On Hold" :
               contact.contact_stage === "lead" ? "Lead" : "Active"}
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

      {/* Links */}
      <div className="flex-shrink-0 flex items-center gap-2">
        {contact.email && (
          <a
            href={`mailto:${contact.email}`}
            onClick={e => e.stopPropagation()}
            className="text-ink-3 hover:text-accent transition-colors"
            title={contact.email}
          >
            <Mail size={14} />
          </a>
        )}
        {contact.linkedin_url && (
          <a
            href={contact.linkedin_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-ink-3 hover:text-accent transition-colors"
            title="LinkedIn"
          >
            <Linkedin size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

export function JobsContacts() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Simple debounce
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

  const contacts = data?.data ?? [];
  const total    = data?.total ?? 0;

  // Group by company for display
  const noLink   = contacts.filter(c => !c.deal);
  const withLink = contacts.filter(c => c.deal);

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search contacts, companies, titles…"
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
                stage === opt.value
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink-2"
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
              <div className="w-8 h-8 rounded-full bg-surface-2" />
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
          {/* Contacts linked to deals */}
          {withLink.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Linked to Deals ({withLink.length})
              </div>
              <div className="rounded-lg border border-border-strong bg-surface overflow-hidden">
                {withLink.map(c => <ContactRow key={c.contact_id} contact={c} />)}
              </div>
            </div>
          )}

          {/* Contacts without a linked deal */}
          {noLink.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">
                Not Yet Linked ({noLink.length})
              </div>
              <div className="rounded-lg border border-border-strong bg-surface overflow-hidden">
                {noLink.map(c => <ContactRow key={c.contact_id} contact={c} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
