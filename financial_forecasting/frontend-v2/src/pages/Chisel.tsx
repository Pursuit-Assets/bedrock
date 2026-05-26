/**
 * Chisel — the Pebble tool/workflow author surface.
 *
 * Phase C.1 (this file): read-only inventory + detail drawer + eval
 * runner. Tools and workflows live under ``pebble/chisel/`` and are
 * served by ``/api/chisel/*`` (proxied through Bedrock).
 *
 * Phase C.2 will add manifest-save endpoints + an inline YAML editor
 * gated behind a ``chisel_write`` permission.
 */

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, GitBranch, Play, RefreshCcw, Settings2 } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import {
  type ChiselUnit,
  type EvalSummary,
  useChiselEval,
  useChiselHealth,
  useChiselReload,
  useChiselTool,
  useChiselTools,
  useChiselWorkflow,
  useChiselWorkflows,
} from "@/services/chisel";

type Selected =
  | { kind: "tool"; name: string }
  | { kind: "workflow"; name: string }
  | null;

export function ChiselPage() {
  const tools = useChiselTools();
  const workflows = useChiselWorkflows();
  const health = useChiselHealth();
  const reload = useChiselReload();
  const evalRun = useChiselEval();

  const [selected, setSelected] = useState<Selected>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);

  const loadErrors = useMemo(() => {
    const errs: string[] = [];
    [...(tools.data ?? []), ...(workflows.data ?? [])].forEach((u) => {
      if (u.load_error) errs.push(`${u.kind}/${u.name}: ${u.load_error}`);
    });
    return errs;
  }, [tools.data, workflows.data]);

  return (
    <div className="mx-auto max-w-[1200px] px-7 py-6 pb-20">
      <PageHeader
        title="Chisel"
        subtitle="Authored tools and workflows powering Pebble."
        actions={
          <>
            <button
              type="button"
              onClick={() => reload.mutate()}
              disabled={reload.isPending}
              className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[13px] hover:bg-surface-2 disabled:opacity-50"
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", reload.isPending && "animate-spin")} />
              Reload
            </button>
            <button
              type="button"
              onClick={async () => {
                const summary = await evalRun.mutateAsync({});
                setEvalSummary(summary);
              }}
              disabled={evalRun.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {evalRun.isPending ? "Running…" : "Run eval"}
            </button>
          </>
        }
      />

      {/* Health banner */}
      {health.data && (
        <div
          className={cn(
            "mb-5 rounded-md border px-4 py-3 text-[13px]",
            health.data.ok
              ? "border-green/30 bg-green-soft text-green"
              : "border-red/30 bg-red-soft text-red",
          )}
        >
          <div className="flex items-center gap-2">
            {health.data.ok ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            <span className="font-medium">
              {health.data.ok ? "Registry healthy" : `Registry has ${health.data.errors.length} error(s)`}
            </span>
            <span className="text-ink-3">
              · {health.data.loaded_tools.length} tools · {health.data.loaded_workflows.length} workflows
              {health.data.lint_warnings.length > 0 && ` · ${health.data.lint_warnings.length} lint warning(s)`}
            </span>
          </div>
          {loadErrors.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px]">
              {loadErrors.slice(0, 5).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Eval results panel */}
      {evalSummary && <EvalSummaryPanel summary={evalSummary} onDismiss={() => setEvalSummary(null)} />}

      {/* Tools section */}
      <Section
        title="Tools"
        icon={<Settings2 className="h-4 w-4" />}
        empty={!tools.isLoading && (tools.data ?? []).length === 0}
        loading={tools.isLoading}
      >
        {(tools.data ?? []).map((u) => (
          <UnitCard key={`tool-${u.name}`} unit={u} onClick={() => setSelected({ kind: "tool", name: u.name })} />
        ))}
      </Section>

      {/* Workflows section */}
      <Section
        title="Workflows"
        icon={<GitBranch className="h-4 w-4" />}
        empty={!workflows.isLoading && (workflows.data ?? []).length === 0}
        loading={workflows.isLoading}
      >
        {(workflows.data ?? []).map((u) => (
          <UnitCard key={`wf-${u.name}`} unit={u} onClick={() => setSelected({ kind: "workflow", name: u.name })} />
        ))}
      </Section>

      <UnitDrawer selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section + UnitCard
// ---------------------------------------------------------------------------

function Section({
  title,
  icon,
  loading,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  loading?: boolean;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink">
        {icon}
        {title}
      </div>
      {loading ? (
        <div className="rounded-md border border-border-strong bg-surface px-4 py-6 text-center text-[13px] text-ink-3">
          Loading…
        </div>
      ) : empty ? (
        <div className="rounded-md border border-border-strong bg-surface px-4 py-6 text-center text-[13px] text-ink-3">
          Nothing here yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>
      )}
    </section>
  );
}

function UnitCard({ unit, onClick }: { unit: ChiselUnit; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border bg-surface px-4 py-3 text-left transition",
        unit.load_error
          ? "border-red/40 hover:border-red"
          : "border-border-strong hover:border-accent hover:shadow-sm",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[14px] font-semibold">{unit.name}</span>
            {unit.requires_human && <Tag variant="amber">human gate</Tag>}
            {unit.slash_command && <Tag variant="accent">{unit.slash_command}</Tag>}
            {unit.has_custom_plan && <Tag variant="default">custom plan</Tag>}
            {unit.load_error && <Tag variant="red">load error</Tag>}
          </div>
          <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-3">{unit.description}</p>
        </div>
        <div className="text-right text-[11px] text-ink-3">
          <div>v{unit.version}</div>
          {unit.cost_estimate_usd > 0 && <div>${unit.cost_estimate_usd.toFixed(3)}</div>}
        </div>
      </div>
      {unit.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unit.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function UnitDrawer({ selected, onClose }: { selected: Selected; onClose: () => void }) {
  const toolDetail = useChiselTool(selected?.kind === "tool" ? selected.name : null);
  const workflowDetail = useChiselWorkflow(selected?.kind === "workflow" ? selected.name : null);
  const detail = selected?.kind === "tool" ? toolDetail.data : workflowDetail.data;

  return (
    <Drawer
      open={!!selected}
      onClose={onClose}
      title={
        <span className="font-mono text-[15px]">
          {selected ? `${selected.kind}/${selected.name}` : ""}
        </span>
      }
      subtitle={detail?.unit.description}
      width={760}
    >
      {!detail ? (
        <div className="px-5 py-6 text-[13px] text-ink-3">Loading…</div>
      ) : (
        <div className="space-y-5 px-5 py-4">
          <DetailMeta unit={detail.unit} />
          <DetailSection title="manifest.yaml" icon={<FileText className="h-3.5 w-3.5" />}>
            <CodeBlock language="yaml" text={detail.manifest_yaml} />
          </DetailSection>

          {detail.input_schema && (
            <DetailSection title="input_schema (strict)" icon={<FileText className="h-3.5 w-3.5" />}>
              <CodeBlock language="json" text={JSON.stringify(detail.input_schema, null, 2)} />
            </DetailSection>
          )}

          {detail.handler_source && (
            <DetailSection
              title="handler.py"
              icon={<FileText className="h-3.5 w-3.5" />}
              subtitle="Read-only. Edits land via PR."
            >
              <CodeBlock language="python" text={detail.handler_source} />
            </DetailSection>
          )}

          {detail.build_plan_source && (
            <DetailSection
              title="build_plan.py"
              icon={<FileText className="h-3.5 w-3.5" />}
              subtitle="Custom plan factory. Read-only."
            >
              <CodeBlock language="python" text={detail.build_plan_source} />
            </DetailSection>
          )}

          {detail.canonical_queries_yaml && (
            <DetailSection
              title="canonical_queries.yaml"
              icon={<FileText className="h-3.5 w-3.5" />}
            >
              <CodeBlock language="yaml" text={detail.canonical_queries_yaml} />
            </DetailSection>
          )}
        </div>
      )}
    </Drawer>
  );
}

function DetailMeta({ unit }: { unit: ChiselUnit }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-[12.5px]">
      <Meta label="version" value={unit.version} />
      <Meta label="cost (USD)" value={`$${unit.cost_estimate_usd.toFixed(3)}`} />
      {unit.kind === "workflow" && (
        <>
          <Meta label="slash" value={unit.slash_command || "—"} />
          <Meta label="intent" value={unit.dispatch_intent || "—"} />
        </>
      )}
      <Meta label="tags" value={unit.tags.length ? unit.tags.join(", ") : "—"} />
      <Meta label="manifest path" value={unit.manifest_path.split("/").slice(-4).join("/")} mono />
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={cn("mt-0.5 text-ink", mono && "font-mono text-[11.5px]")}>{value}</div>
    </div>
  );
}

function DetailSection({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
        {icon}
        {title}
        {subtitle && <span className="ml-1 text-ink-3 font-normal">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function CodeBlock({ text, language }: { text: string; language?: string }) {
  void language;
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-border-strong bg-surface-2 px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-ink">
      {text}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Eval summary panel
// ---------------------------------------------------------------------------

function EvalSummaryPanel({ summary, onDismiss }: { summary: EvalSummary; onDismiss: () => void }) {
  const allSkipped = summary.skipped === summary.total;
  return (
    <div className="mb-6 rounded-md border border-border-strong bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[14px] font-semibold">
          Eval — {summary.passed}/{summary.total} passed
          {summary.failed > 0 && <span className="ml-1 text-red">· {summary.failed} failed</span>}
          {summary.skipped > 0 && <span className="ml-1 text-ink-3">· {summary.skipped} skipped</span>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-ink-3 hover:text-ink"
        >
          Dismiss
        </button>
      </div>
      {allSkipped && (
        <div className="mb-2 text-[12px] text-ink-3">
          Schema validation only — set <code className="font-mono">ANTHROPIC_API_KEY</code> on the
          Pebble service to exercise the live planner.
        </div>
      )}
      <ul className="space-y-1 text-[12px]">
        {summary.results.map((r) => (
          <li key={`${r.unit}/${r.query_id}`} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-0.5 inline-block h-2 w-2 flex-shrink-0 rounded-full",
                r.skipped ? "bg-ink-3" : r.passed ? "bg-green" : "bg-red",
              )}
            />
            <span className="font-mono">{r.unit}/{r.query_id}</span>
            {r.skipped && r.skip_reason && (
              <span className="text-ink-3">— {r.skip_reason}</span>
            )}
            {!r.skipped && r.duration_ms > 0 && (
              <span className="text-ink-3">{r.duration_ms}ms</span>
            )}
            {r.planner_error && (
              <span className="text-red">planner_error: {r.planner_error}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
