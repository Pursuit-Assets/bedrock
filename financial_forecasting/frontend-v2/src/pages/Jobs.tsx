import { useState } from "react";
import { BarChart3, Kanban } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { JobsTeam } from "./jobs/JobsTeam";
import { JobsLeadership } from "./jobs/JobsLeadership";

type View = "team" | "leadership";

const VIEWS = [
  { id: "team" as View,       label: "Team View",       icon: Kanban,   desc: "Day-to-day deal management" },
  { id: "leadership" as View, label: "Leadership",      icon: BarChart3, desc: "Pipeline health & metrics" },
];

export function JobsPage() {
  const [view, setView] = useState<View>("team");

  return (
    <div className="flex flex-col gap-0 px-7 py-6 pb-12">
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

      <div className="mt-2">
        {view === "team"       && <JobsTeam />}
        {view === "leadership" && <JobsLeadership />}
      </div>
    </div>
  );
}
