import { useMemo } from "react";
import { toast } from "sonner";

import { Drawer } from "@/components/ui/Drawer";
import {
  InlineDate,
  InlineSelect,
  InlineText,
} from "@/components/ui/InlineEdit";
import { StageChip } from "@/components/ui/StageChip";
import { stageStatus, SF_STAGE_OPTIONS } from "@/lib/stages";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useActivities } from "@/services/activities";
import {
  useOpportunityPayments,
  useOpportunityTasks,
  useUpdateOpportunity,
  useUpdateOpportunityStage,
} from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useActiveUsers } from "@/services/users";
import type { SfOpportunity, SfPayment, SfTask } from "@/types/salesforce";

const DRAWER_STORAGE_KEY = "bedrock:opp-drawer:width";

const FORECAST_OPTIONS = [
  { value: "Pipeline", label: "Pipeline" },
  { value: "Best Case", label: "Best Case" },
  { value: "Commit", label: "Commit" },
  { value: "Omitted", label: "Omitted" },
  { value: "Closed", label: "Closed" },
];

/**
 * Right-side drawer surfacing the meta + child collections for a single
 * opportunity: tasks, payments, recent activity. Mirrors AccountDrawer.
 *
 * Stage / Amount / Close Date / Probability / Owner / NextStep /
 * Description are editable inline when the user has `edit_own_opportunities`
 * (or `edit_all_opportunities`). Stage transitions go through the
 * dedicated `useUpdateOpportunityStage` mutation so the server-side
 * award auto-create handler fires on closed-won transitions; the success
 * toast surfaces `award_created`.
 */
export function OpportunityDrawer({
  opportunity,
  onClose,
}: {
  opportunity: SfOpportunity | null;
  onClose: () => void;
}) {
  const open = !!opportunity;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={opportunity?.Name ?? "Opportunity"}
      subtitle={
        opportunity
          ? [opportunity.Account?.Name, opportunity.RecordType?.Name]
              .filter(Boolean)
              .join(" · ") || undefined
          : undefined
      }
      linkTo={opportunity ? `/opportunities/${opportunity.Id}` : undefined}
      width={680}
      resizable
      minWidth={480}
      maxWidth={960}
      storageKey={DRAWER_STORAGE_KEY}
    >
      {opportunity ? <OpportunityDrawerBody opp={opportunity} /> : null}
    </Drawer>
  );
}

function OpportunityDrawerBody({ opp }: { opp: SfOpportunity }) {
  const oppId = opp.Id;
  const { data: tasks = [] } = useOpportunityTasks(oppId);
  const { data: payments = [] } = useOpportunityPayments(oppId);
  const { data: activities = [] } = useActivities({
    opportunityId: oppId,
    limit: 30,
  });

  const updateOpp = useUpdateOpportunity();
  const updateStage = useUpdateOpportunityStage();
  const usersQ = useActiveUsers();
  const canEditOwn = usePerm("edit_own_opportunities");
  const canEditAll = usePerm("edit_all_opportunities");
  const canEdit = canEditOwn || canEditAll;

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  /** Wrap a save so failures bubble up a hard-to-miss toast in addition
   *  to the in-cell red-icon affordance. Always returns void so it slots
   *  into `InlineEdit`'s `onSave` signature. */
  const withToast = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast.error(`${label}: ${msg}`);
      throw e;
    }
  };

  const saveStage = (next: string) =>
    withToast("Stage save failed", () =>
      updateStage.mutateAsync({ id: oppId, newStage: next }),
    );

  const saveAmount = (raw: string) =>
    withToast("Amount save failed", async () => {
      const cleaned = raw.replace(/[$,\s]/g, "");
      const parsed = cleaned === "" ? null : Number(cleaned);
      if (parsed != null && !Number.isFinite(parsed)) {
        throw new Error("Not a number");
      }
      await updateOpp.mutateAsync({ id: oppId, patch: { Amount: parsed } });
    });

  const saveCloseDate = (next: string | null) =>
    withToast("Close date save failed", () =>
      updateOpp.mutateAsync({ id: oppId, patch: { CloseDate: next } }),
    );

  const saveProbability = (raw: string) =>
    withToast("Probability save failed", async () => {
      const cleaned = raw.replace(/[%\s]/g, "");
      const parsed = cleaned === "" ? null : Number.parseInt(cleaned, 10);
      if (parsed != null) {
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          throw new Error("0–100");
        }
      }
      await updateOpp.mutateAsync({
        id: oppId,
        patch: { Manager_Probability_Override__c: parsed },
      });
    });

  const saveOwner = (ownerId: string) =>
    withToast("Owner save failed", async () => {
      const ownerName =
        (usersQ.data ?? []).find((u) => u.Id === ownerId)?.Name ?? null;
      await updateOpp.mutateAsync({
        id: oppId,
        patch: { OwnerId: ownerId },
        displayPatch: { Owner: { Name: ownerName } },
      });
    });

  const saveForecast = (next: string) =>
    withToast("Forecast save failed", () =>
      updateOpp.mutateAsync({ id: oppId, patch: { ForecastCategory: next } }),
    );

  const saveNextStep = (next: string) =>
    withToast("Next-step save failed", () =>
      updateOpp.mutateAsync({ id: oppId, patch: { NextStep: next } }),
    );

  const saveDescription = (next: string) =>
    withToast("Description save failed", () =>
      updateOpp.mutateAsync({ id: oppId, patch: { Description: next } }),
    );

  const probDisplay = (opp.Manager_Probability_Override__c ?? opp.Probability ?? null);

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Stage"
          value={
            canEdit ? (
              <InlineSelect
                value={opp.StageName}
                options={SF_STAGE_OPTIONS}
                onSave={saveStage}
                renderValue={() => (
                  <StageChip stage={opp.StageName} status={stageStatus(opp)} />
                )}
                emptyLabel="—"
              />
            ) : (
              <StageChip stage={opp.StageName} status={stageStatus(opp)} />
            )
          }
        />
        <Stat
          label="Amount"
          value={
            canEdit ? (
              <InlineText
                value={opp.Amount != null ? String(opp.Amount) : ""}
                onSave={saveAmount}
                formatDisplay={(raw) => {
                  const n = Number(raw);
                  return Number.isFinite(n) && n > 0 ? fmtMoneyFull(n) : "—";
                }}
                placeholder="0"
                emptyLabel="—"
                className="mono text-[15px] font-semibold tabular-nums"
              />
            ) : (
              <span className="mono text-[15px] font-semibold tabular-nums">
                {opp.Amount ? fmtMoneyFull(opp.Amount) : "—"}
              </span>
            )
          }
        />
        <Stat
          label="Close"
          value={
            canEdit ? (
              <InlineDate value={opp.CloseDate ?? null} onSave={saveCloseDate} />
            ) : (
              <span className="mono text-[13px] font-medium tabular-nums">
                {fmtDate(opp.CloseDate)}
              </span>
            )
          }
        />
      </div>

      {/* Meta block */}
      <Section title="Details">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-[12.5px]">
          <Meta label="Owner">
            {canEdit && ownerOptions.length > 0 ? (
              <InlineSelect
                value={opp.OwnerId ?? ""}
                options={ownerOptions}
                onSave={saveOwner}
                renderValue={(v) =>
                  ownerOptions.find((o) => o.value === v)?.label ??
                  opp.Owner?.Name ??
                  "—"
                }
                emptyLabel="—"
              />
            ) : (
              <span>{opp.Owner?.Name ?? <span className="text-ink-4">—</span>}</span>
            )}
          </Meta>
          <Meta label="Probability">
            {canEdit ? (
              <InlineText
                value={probDisplay != null ? String(probDisplay) : ""}
                onSave={saveProbability}
                formatDisplay={(raw) => {
                  const n = Number(raw);
                  return Number.isFinite(n) ? `${n}%` : "—";
                }}
                placeholder="0"
                emptyLabel="—"
              />
            ) : (
              <span>{probDisplay != null ? `${probDisplay}%` : <span className="text-ink-4">—</span>}</span>
            )}
          </Meta>
          <Meta label="Forecast">
            {canEdit ? (
              <InlineSelect
                value={opp.ForecastCategory ?? ""}
                options={FORECAST_OPTIONS}
                onSave={saveForecast}
                emptyLabel="—"
              />
            ) : (
              <span>{opp.ForecastCategory ?? <span className="text-ink-4">—</span>}</span>
            )}
          </Meta>
          <Meta label="Lead source" value={opp.LeadSource} />
          <Meta label="Type" value={opp.RecordType?.Name} />
          <Meta
            label="Primary contact"
            value={opp.npsp__Primary_Contact__r?.Name}
          />
        </dl>
      </Section>

      {/* Next step + description */}
      <Section title="Plan">
        <div className="flex flex-col gap-3 px-4 py-3 text-[12.5px]">
          <Meta label="Next step">
            {canEdit ? (
              <InlineText
                value={opp.NextStep ?? ""}
                onSave={saveNextStep}
                placeholder="What's the next move?"
                emptyLabel="—"
                multiline
              />
            ) : opp.NextStep ? (
              <span className="whitespace-pre-wrap">{opp.NextStep}</span>
            ) : (
              <span className="text-ink-4">—</span>
            )}
          </Meta>
          <Meta label="Description">
            {canEdit ? (
              <InlineText
                value={opp.Description ?? ""}
                onSave={saveDescription}
                placeholder="Add context"
                emptyLabel="No description."
                multiline
              />
            ) : opp.Description ? (
              <span className="whitespace-pre-wrap">{opp.Description}</span>
            ) : (
              <span className="text-ink-4">No description.</span>
            )}
          </Meta>
        </div>
      </Section>

      {/* Tasks */}
      <Section title={`Tasks (${tasks.length})`}>
        {tasks.length === 0 ? (
          <Empty>No tasks logged on this opportunity.</Empty>
        ) : (
          <>
            {tasks.filter((t) => !t.IsClosed).length > 0 ? (
              <ul className="flex flex-col">
                {tasks
                  .filter((t) => !t.IsClosed)
                  .map((t) => (
                    <TaskRow key={t.Id} t={t} />
                  ))}
              </ul>
            ) : null}
            {tasks.filter((t) => t.IsClosed).length > 0 ? (
              <details className="border-t border-border-strong">
                <summary className="cursor-pointer px-4 py-2 text-[11.5px] text-ink-3 hover:text-ink">
                  {tasks.filter((t) => t.IsClosed).length} closed
                </summary>
                <ul className="flex flex-col">
                  {tasks
                    .filter((t) => t.IsClosed)
                    .slice(0, 20)
                    .map((t) => (
                      <TaskRow key={t.Id} t={t} />
                    ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </Section>

      {/* Payments */}
      <Section title={`Payments (${payments.length})`}>
        {payments.length === 0 ? (
          <Empty>No payments scheduled.</Empty>
        ) : (
          <ul className="flex flex-col">
            {payments.map((p) => (
              <PaymentRow key={p.Id} p={p} />
            ))}
          </ul>
        )}
      </Section>

      {/* Activity timeline */}
      <Section title={`Activity (${activities.length})`}>
        {activities.length === 0 ? (
          <Empty>No activities logged.</Empty>
        ) : (
          <ul className="flex flex-col">
            {activities.slice(0, 12).map((a) => (
              <li
                key={a.id}
                className="flex items-start gap-2 border-b border-border-strong px-4 py-2 last:border-b-0"
              >
                <Tag>{a.type}</Tag>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">
                    {a.subject ?? "(no subject)"}
                  </div>
                  {a.email_snippet || a.description ? (
                    <div className="line-clamp-1 text-[11.5px] text-ink-3">
                      {a.email_snippet ?? a.description}
                    </div>
                  ) : null}
                </div>
                <div className="mono flex-shrink-0 text-[10.5px] text-ink-3">
                  {fmtDate(a.occurred_at ?? a.created_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {!canEdit ? (
        <div className="rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
          You don't have permission to edit opportunities.
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ t }: { t: SfTask }) {
  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
          t.IsClosed ? "bg-surface-2 text-ink-3" : "bg-amber-soft text-amber",
        )}
      >
        {t.Status ?? "Open"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {t.Subject ?? "(no subject)"}
      </span>
      <span className="mono w-24 flex-shrink-0 text-right text-[11px] text-ink-3">
        {fmtDate(t.ActivityDate)}
      </span>
    </li>
  );
}

function PaymentRow({ p }: { p: SfPayment }) {
  const paid = !!p.npe01__Paid__c;
  const writtenOff = !!p.npe01__Written_Off__c;
  const status = writtenOff ? "Written off" : paid ? "Paid" : (p.Payment_Status__c ?? "Scheduled");
  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
          paid
            ? "bg-green-soft text-green"
            : writtenOff
              ? "bg-surface-2 text-ink-3"
              : "bg-amber-soft text-amber",
        )}
      >
        {status}
      </span>
      <span className="mono min-w-0 flex-1 truncate text-[12.5px] tabular-nums">
        {p.npe01__Payment_Amount__c
          ? fmtMoneyFull(p.npe01__Payment_Amount__c, true)
          : "—"}
      </span>
      <span className="mono w-28 flex-shrink-0 text-right text-[11px] text-ink-3">
        {fmtDate(p.npe01__Payment_Date__c ?? p.npe01__Scheduled_Date__c)}
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border-strong bg-surface-2 px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-surface-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-5 text-center text-[12px] text-ink-3">
      {children}
    </div>
  );
}

function Meta({
  label,
  value,
  full,
  children,
}: {
  label: string;
  value?: React.ReactNode;
  full?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col", full && "col-span-2")}>
      <dt className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </dt>
      <dd className="text-[12.5px] text-ink">
        {children ??
          (value != null && value !== "" ? value : <span className="text-ink-4">—</span>)}
      </dd>
    </div>
  );
}
