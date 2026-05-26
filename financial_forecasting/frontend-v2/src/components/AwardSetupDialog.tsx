import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import {
  useAward,
  useUpdateAward,
} from "@/services/awards";
import { useCreateTask } from "@/services/opportunities";
import {
  useCreateProject,
  useLinkProjectToOpportunity,
  useProjects,
} from "@/services/projects";

/**
 * Post-stage award setup workflow — fires after a Contracting →
 * Collecting / In Effect transition that produced a new award. Three
 * sections, each independently saveable or deferrable via a
 * "Remind me later" affordance that drops a SF Task (due in 7 days)
 * onto the parent opportunity.
 *
 *   1. Award start + end dates → patches the Bedrock Award row
 *   2. Reporting requirements + cadence → patches the Award row
 *      (free-text notes for now, structured cadence picklist)
 *   3. Project link (Bedrock projects) — pick existing or create new
 *
 * The dialog can be dismissed at any point; pending sections do NOT
 * block stage progression (the stage change already committed). It's
 * a follow-up checklist, not a gate.
 */
export function AwardSetupDialog({
  awardId,
  opportunityId,
  onClose,
}: {
  awardId: string;
  opportunityId: string;
  onClose: () => void;
}) {
  const awardQ = useAward(awardId);
  const updateAward = useUpdateAward();
  const createTask = useCreateTask();
  const projectsQ = useProjects();
  const createProject = useCreateProject();
  const linkProject = useLinkProjectToOpportunity();

  const award = awardQ.data;

  // ── Section 1: Award dates ────────────────────────────────────────
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [datesSaved, setDatesSaved] = useState(false);

  // Seed inputs once when the award row loads. Effect, not memo —
  // setting state during render would loop.
  const [datesSeeded, setDatesSeeded] = useState(false);
  useEffect(() => {
    if (!award || datesSeeded) return;
    setStartDate(award.award_date ?? "");
    setEndDate(award.period_end_date ?? "");
    setDatesSeeded(true);
  }, [award, datesSeeded]);

  const saveDates = async () => {
    if (!startDate && !endDate) {
      toast.error("Set at least one date or use Remind me later");
      return;
    }
    try {
      await updateAward.mutateAsync({
        id: awardId,
        patch: {
          award_date: startDate || null,
          period_end_date: endDate || null,
        },
      });
      setDatesSaved(true);
      toast.success("Award dates saved");
    } catch (e) {
      toast.error(`Couldn't save dates: ${errorMessage(e)}`);
    }
  };

  const remindDates = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "Confirm award start + end dates",
      "Post-Collecting follow-up: set the award start date (award_date) and period end date so reporting + payment schedules align.",
    ).then(() => setDatesSaved(true));
  };

  // ── Section 2: Reporting ──────────────────────────────────────────
  const [reportingNotes, setReportingNotes] = useState<string>("");
  const [reportingFrequency, setReportingFrequency] = useState<string>("");
  const [reportingSaved, setReportingSaved] = useState(false);

  const [reportingSeeded, setReportingSeeded] = useState(false);
  useEffect(() => {
    if (!award || reportingSeeded) return;
    setReportingNotes(award.notes ?? "");
    setReportingFrequency(award.reporting_frequency ?? "");
    setReportingSeeded(true);
  }, [award, reportingSeeded]);

  const saveReporting = async () => {
    if (!reportingNotes.trim() && !reportingFrequency) {
      toast.error("Enter reporting requirements or pick a cadence");
      return;
    }
    try {
      await updateAward.mutateAsync({
        id: awardId,
        patch: {
          notes: reportingNotes,
          reporting_frequency: reportingFrequency || null,
        },
      });
      setReportingSaved(true);
      toast.success("Reporting requirements saved");
    } catch (e) {
      toast.error(`Couldn't save reporting: ${errorMessage(e)}`);
    }
  };

  const remindReporting = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "Log reporting requirements + schedule",
      "Post-Collecting follow-up: capture the funder's reporting requirements (deliverables, cadence, first-report due date) on the award.",
    ).then(() => setReportingSaved(true));
  };

  // ── Section 3: Project ────────────────────────────────────────────
  const [projectMode, setProjectMode] = useState<"none" | "link" | "create">("none");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [projectSaved, setProjectSaved] = useState(false);

  const eligibleProjects = useMemo(
    () => (projectsQ.data ?? []).filter((p) => !p.opportunity_id || p.opportunity_id === opportunityId),
    [projectsQ.data, opportunityId],
  );

  const saveProject = async () => {
    try {
      if (projectMode === "link") {
        if (!selectedProjectId) {
          toast.error("Pick a project to link");
          return;
        }
        await linkProject.mutateAsync({ projectId: selectedProjectId, opportunityId });
        toast.success("Project linked");
      } else if (projectMode === "create") {
        if (!newProjectName.trim()) {
          toast.error("Give the new project a name");
          return;
        }
        await createProject.mutateAsync({
          name: newProjectName.trim(),
          opportunity_id: opportunityId,
        });
        toast.success("Project created and linked");
      }
      setProjectSaved(true);
    } catch (e) {
      toast.error(`Couldn't save project: ${errorMessage(e)}`);
    }
  };

  const remindProject = () => {
    void createReminderTask(
      createTask,
      opportunityId,
      "Create or link implementation project",
      "Post-Collecting follow-up: if this award requires implementation, create or link a project so the team has a working space for deliverables.",
    ).then(() => setProjectSaved(true));
  };

  const allDone = datesSaved && reportingSaved && projectSaved;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-[700px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl">
        <header className="flex items-start justify-between border-b border-border-strong px-5 py-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Award setup
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold text-ink">
              Set up the new award
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 text-ink-3 hover:text-ink-2"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
            The award record auto-generated from this stage change. Confirm the dates, reporting plan, and project setup
            below — or use <strong>Remind me later</strong> on any section to drop a task on the opportunity (due in 1 week).
          </p>

          <div className="flex flex-col gap-3">
            <SetupSection
              label="1 · Award start + end dates"
              saved={datesSaved}
              saving={updateAward.isPending || createTask.isPending}
              onSave={saveDates}
              onRemindLater={remindDates}
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    Start date
                  </span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                    End date
                  </span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className={inputCls}
                  />
                </label>
              </div>
            </SetupSection>

            <SetupSection
              label="2 · Reporting requirements + schedule"
              saved={reportingSaved}
              saving={updateAward.isPending}
              onSave={saveReporting}
              onRemindLater={remindReporting}
            >
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                  Reporting deliverables
                </span>
                <textarea
                  value={reportingNotes}
                  onChange={(e) => setReportingNotes(e.target.value)}
                  rows={3}
                  placeholder="Funder requirements — e.g. quarterly impact report, mid-year financial, annual narrative…"
                  className="resize-y rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
                />
              </label>
              <label className="mt-2 flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                  Cadence
                </span>
                <select
                  value={reportingFrequency}
                  onChange={(e) => setReportingFrequency(e.target.value)}
                  className={inputCls}
                >
                  <option value="">No set cadence</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="semiannual">Semi-annually</option>
                  <option value="annual">Annually</option>
                  <option value="custom">Custom — see notes</option>
                </select>
              </label>
            </SetupSection>

            <SetupSection
              label="3 · Project (if implementation required)"
              saved={projectSaved}
              saving={createProject.isPending || linkProject.isPending}
              onSave={projectMode === "none" ? null : saveProject}
              onRemindLater={remindProject}
            >
              <div className="flex items-center gap-2 text-[12.5px]">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "none"}
                    onChange={() => setProjectMode("none")}
                  />
                  No implementation needed
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "link"}
                    onChange={() => setProjectMode("link")}
                  />
                  Link existing
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="project-mode"
                    checked={projectMode === "create"}
                    onChange={() => setProjectMode("create")}
                  />
                  Create new
                </label>
              </div>
              {projectMode === "link" ? (
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className={`${inputCls} mt-2`}
                >
                  <option value="">Pick a project…</option>
                  {eligibleProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {projectMode === "create" ? (
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name"
                  className={`${inputCls} mt-2`}
                />
              ) : null}
            </SetupSection>
          </div>

          {allDone ? (
            <div className="mt-4 rounded border border-green/30 bg-green/5 px-3 py-2 text-[12.5px] text-green">
              All set — you can close this dialog.
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-strong bg-surface-2/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="text-[12.5px] text-ink-3 hover:text-ink-2"
          >
            {allDone ? "Done" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

const inputCls =
  "h-8 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent";

function SetupSection({
  label,
  saved,
  saving,
  onSave,
  onRemindLater,
  children,
}: {
  label: string;
  saved: boolean;
  saving: boolean;
  /** When null, the Save action is hidden (e.g. for the "no
   *  implementation needed" project state where nothing to save). */
  onSave: (() => void) | null;
  onRemindLater: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded border border-border-strong bg-surface-2/40 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">{label}</span>
        {saved ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-green">
            <CheckCircle2 size={12} /> done
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">{children}</div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onRemindLater}
          disabled={saving}
          className="text-[11.5px] text-ink-3 underline-offset-2 hover:underline disabled:opacity-50"
          title="Create a task on the opportunity, due in 1 week"
        >
          Remind me later
        </button>
        {onSave ? (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ink px-2.5 text-[11.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            Save
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              toast.success("Acknowledged — no implementation needed");
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ink px-2.5 text-[11.5px] font-medium text-surface hover:opacity-90"
          >
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

interface CreateTaskHook {
  mutateAsync: (input: {
    opportunityId: string;
    body: {
      Subject: string;
      ActivityDate?: string | null;
      Description?: string | null;
    };
  }) => Promise<unknown>;
  isPending?: boolean;
}

async function createReminderTask(
  createTask: CreateTaskHook,
  opportunityId: string,
  subject: string,
  description: string,
): Promise<void> {
  // Due 7 days from today — the playbook's "remind me next week" rule.
  const due = new Date();
  due.setDate(due.getDate() + 7);
  const dueIso = due.toISOString().slice(0, 10);
  try {
    await createTask.mutateAsync({
      opportunityId,
      body: {
        Subject: subject,
        ActivityDate: dueIso,
        Description: description,
      },
    });
    toast.success(`Reminder created — due ${dueIso}`);
  } catch (e) {
    toast.error(`Couldn't create reminder: ${errorMessage(e)}`);
  }
}

function errorMessage(e: unknown): string {
  const err = e as {
    response?: { data?: { detail?: string | { message?: string } } };
    message?: string;
  };
  const detail = err.response?.data?.detail;
  if (typeof detail === "string") return detail;
  return detail?.message ?? err.message ?? "Unknown error";
}
