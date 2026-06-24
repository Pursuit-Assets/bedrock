import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Home, BarChart3, Building2, Kanban, Users, GraduationCap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";
import { JobsHome } from "./jobs/JobsHome";
import { JobsAccountHub } from "./jobs/JobsAccountHub";
import { JobsTeam } from "./jobs/JobsTeam";
import { JobsLeadership } from "./jobs/JobsLeadership";
import { JobsContacts } from "./jobs/JobsContacts";
import { JobsBuilders } from "./jobs/JobsBuilders";

type View = "home" | "accounts" | "performance" | "team" | "contacts" | "builders";

const VIEWS = [
  { id: "home" as View,        label: "Home",        icon: Home,      desc: "Daily command center — tasks, interviews, triage" },
  { id: "performance" as View, label: "Performance", icon: BarChart3, desc: "Pipeline health & metrics" },
  { id: "accounts" as View,    label: "Accounts",    icon: Building2, desc: "Account-level hub — opps + contacts" },
  { id: "team" as View,        label: "Opportunities", icon: Kanban,  desc: "Day-to-day deal management" },
  { id: "contacts" as View,    label: "Contacts",    icon: Users,     desc: "All employer contacts" },
  { id: "builders" as View,    label: "Builders",    icon: GraduationCap, desc: "Per-builder job search" },
];

const VALID_VIEWS = new Set<View>(["home", "accounts", "performance", "team", "contacts", "builders"]);

export function JobsPage() {
  const [searchParams] = useSearchParams();
  // Deep-link support (e.g. from global search):
  //   ?view=contacts&q=<text>           — seed the find-any search
  //   ?view=contacts&contact=<id>       — open that contact's detail drawer
  const paramView = searchParams.get("view") as View | null;
  const initialView: View = paramView && VALID_VIEWS.has(paramView) ? paramView : "home";
  const initialQuery = searchParams.get("q") ?? undefined;
  const contactParam = searchParams.get("contact");
  const initialContactId = contactParam && /^\d+$/.test(contactParam) ? Number(contactParam) : undefined;
  // Persisted so returning (Back) from a detail page restores the same tab.
  const [view, setView] = useSessionState<View>("jobs:view", initialView);
  // An explicit ?view= deep-link still wins.
  useEffect(() => {
    if (paramView && VALID_VIEWS.has(paramView)) setView(paramView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramView]);

  return (
    <div className="flex flex-col gap-0 px-7 py-4 pb-12">
      <PageHeader
        title="Jobs Pipeline"
        subtitle="Employer outreach, builder matching, and placement tracking."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
            {VIEWS.map((v) => {
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  onClick={() => setView(v.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                    view === v.id
                      ? "bg-surface text-ink shadow-sm"
                      : "text-ink-3 hover:text-ink-2"
                  )}
                >
                  <Icon size={13} />
                  {v.label}
                </button>
              );
            })}
          </div>
        }
      />

      <div className="mt-1">
        {view === "home"        && <JobsHome />}
        {view === "accounts"    && <JobsAccountHub initialQuery={initialQuery} />}
        {view === "performance" && <JobsLeadership />}
        {view === "team"        && <JobsTeam />}
        {view === "contacts"    && <JobsContacts initialQuery={initialQuery} initialContactId={initialContactId} />}
        {view === "builders"    && <JobsBuilders />}
      </div>
    </div>
  );
}
