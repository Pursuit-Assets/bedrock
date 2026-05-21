/**
 * Payments page (/payments).
 *
 * Mirror of the Pipeline page but for npe01__OppPayment__c records:
 *   - virtualized table, resizable + sortable + drag-to-reorder columns
 *   - chip-style filter rig (same `pages/cleanup/Filters` rig used by
 *     Pipeline / Cleanup tabs)
 *   - inline edits on every editable column (amount, scheduled date,
 *     payment date, paid flag, method, written off, department, GL,
 *     reconciled flag)
 *   - SavedViewsPicker (scopeKey="payments") so users can persist
 *     custom views — e.g. "scheduled after current quarter" to mirror
 *     Angie's SF report
 *   - CSV export of the currently-filtered set
 *
 * Read path: usePayments() → /api/salesforce/payments.
 * Write path: useUpdateAnyPayment() → PUT /api/salesforce/payments/{id}.
 *
 * Opp-side fields (owner, stage, opp amount, manager probability,
 * close date, record type, active flag) are SELECTed via the
 * npe01__Opportunity__r relationship — no extra round-trips. See
 * PAYMENT_SOQL_FIELDS in main.py.
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ExportCsvButton } from "@/components/ui/ExportCsvButton";
import { PageHeader } from "@/components/PageHeader";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import type { CsvColumn } from "@/lib/csv";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate, fmtMoney, fmtMoneyFull } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "@/pages/cleanup/Filters";
import { cn } from "@/lib/utils";
import { usePerm } from "@/services/permissions";
import {
  usePayments,
  useUpdateAnyPayment,
  type PaymentPatch,
  type SfPayment,
} from "@/services/payments";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Risk-adjusted value = Opp Amount × (manager-probability-override
 *  ?? Probability) / 100. Returns null when amount or probability is
 *  missing — keeps the value column comparable to SF's own
 *  "Expected Revenue" calculation. */
function riskAdjusted(p: SfPayment): number | null {
  const opp = p.npe01__Opportunity__r;
  if (!opp) return null;
  const amt = opp.Amount;
  if (amt == null) return null;
  const prob =
    opp.Manager_Probability_Override__c ?? opp.Probability ?? null;
  if (prob == null) return null;
  return amt * (prob / 100);
}

// ── Scope pills ─────────────────────────────────────────────────────────────

const SCOPES = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paid", label: "Paid" },
  { value: "writtenOff", label: "Written off" },
  { value: "delinquent", label: "Delinquent" },
] as const;
type Scope = (typeof SCOPES)[number]["value"];

function inScope(p: SfPayment, scope: Scope): boolean {
  if (scope === "all") return true;
  if (scope === "scheduled") return !p.npe01__Paid__c && !p.npe01__Written_Off__c;
  if (scope === "paid") return Boolean(p.npe01__Paid__c);
  if (scope === "writtenOff") return Boolean(p.npe01__Written_Off__c);
  if (scope === "delinquent") return Boolean(p.Delinquent__c);
  return true;
}

// ── Filter model ────────────────────────────────────────────────────────────

const PAYMENT_METHODS = [
  "ACH", "Benevity", "Cash", "Check", "Credit Card", "Cryptocurrency",
  "Direct Pay", "Loan Forgiveness", "PayPal", "QuickBooks", "Stock",
  "Stripe", "Venmo", "Wire",
];

const DEPARTMENTS = [
  "301--Philanthropy",
  "101--Program",
  "200--Central Processing Unit",
  "402--PBC Business Operations",
];

const GL_ACCOUNTS = [
  "4010--Individual contributions",
  "4020--Corporate contributions",
  "4030--Foundation contributions",
  "4040--Board Contributions",
  "4050--Techbash",
  "4500--Local government grants",
  "4510--State grants",
  "4520--Other Grants",
  "5010--Pursuit Bond",
  "5040--Employment Commitments",
  "7540--Bank fees",
];

const PAYMENT_FILTERABLE = {
  paymentNumber: { label: "Payment #", type: "text", getValue: (p: SfPayment) => p.Name ?? "" },
  opportunity: { label: "Opportunity", type: "text", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Name ?? "" },
  account: { label: "Account", type: "text", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Account?.Name ?? "" },
  oppOwner: { label: "Opp owner", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.OwnerId ?? "" },
  stage: { label: "Stage", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.StageName ?? "" },
  recordType: { label: "Record type", type: "select", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.RecordType?.Name ?? "" },
  active: { label: "Active opportunity", type: "select", getValue: (p: SfPayment) => (p.npe01__Opportunity__r?.Active_Opportunity__c ? "Yes" : "No") },
  oppAmount: { label: "Opp amount", type: "number", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Amount ?? null },
  mgrProb: { label: "Mgr probability", type: "number", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? p.npe01__Opportunity__r?.Probability ?? null },
  riskAdjusted: { label: "Risk-adjusted value", type: "number", getValue: (p: SfPayment) => riskAdjusted(p) },
  closeDate: { label: "Close date", type: "date", getValue: (p: SfPayment) => p.npe01__Opportunity__r?.CloseDate ?? null },
  amount: { label: "Payment amount", type: "number", getValue: (p: SfPayment) => p.npe01__Payment_Amount__c ?? null },
  scheduledDate: { label: "Scheduled date", type: "date", getValue: (p: SfPayment) => p.npe01__Scheduled_Date__c ?? null },
  paymentDate: { label: "Payment date", type: "date", getValue: (p: SfPayment) => p.npe01__Payment_Date__c ?? null },
  paid: { label: "Paid", type: "select", getValue: (p: SfPayment) => (p.npe01__Paid__c ? "Yes" : "No") },
  writtenOff: { label: "Written off", type: "select", getValue: (p: SfPayment) => (p.npe01__Written_Off__c ? "Yes" : "No") },
  method: { label: "Method", type: "select", getValue: (p: SfPayment) => p.npe01__Payment_Method__c ?? "" },
  status: { label: "Status", type: "select", getValue: (p: SfPayment) => p.Paid_Status__c ?? p.Payment_Status__c ?? "" },
  delinquent: { label: "Delinquent", type: "select", getValue: (p: SfPayment) => (p.Delinquent__c ? "Yes" : "No") },
  department: { label: "Department", type: "select", getValue: (p: SfPayment) => p.Department__c ?? "" },
  glAccount: { label: "GL account", type: "select", getValue: (p: SfPayment) => p.GL_Account__c ?? "" },
  reconciled: { label: "Reconciled with finance", type: "select", getValue: (p: SfPayment) => (p.Reconciled_with_Finance__c ? "Yes" : "No") },
  amountReceived: { label: "Amount received", type: "number", getValue: (p: SfPayment) => p.Amount_Received__c ?? null },
  amountMinusReceived: { label: "Amount minus received", type: "number", getValue: (p: SfPayment) => p.Amount_Minus_Received__c ?? null },
  createdDate: { label: "Created", type: "date", getValue: (p: SfPayment) => p.CreatedDate ?? null },
} satisfies Record<string, FieldMeta<SfPayment>>;

type PaymentField = keyof typeof PAYMENT_FILTERABLE;

// ── Columns ─────────────────────────────────────────────────────────────────
//
// "opportunity" is a composite cell showing opp name + account name on
// two lines (account is no longer a standalone column — same UX as
// Pipeline).

type ColKey =
  | "paymentNumber"
  | "opportunity"
  | "oppOwner"
  | "stage"
  | "recordType"
  | "active"
  | "oppAmount"
  | "mgrProb"
  | "riskAdjusted"
  | "closeDate"
  | "amount"
  | "scheduledDate"
  | "paymentDate"
  | "paid"
  | "method"
  | "status"
  | "department"
  | "glAccount"
  | "amountReceived"
  | "reconciled"
  | "writtenOff"
  | "createdDate";

const COLUMN_ORDER: ColKey[] = [
  "paymentNumber",
  "opportunity",
  "oppOwner",
  "stage",
  "recordType",
  "active",
  "oppAmount",
  "mgrProb",
  "riskAdjusted",
  "closeDate",
  "amount",
  "scheduledDate",
  "paymentDate",
  "paid",
  "method",
  "status",
  "department",
  "glAccount",
  "amountReceived",
  "reconciled",
  "writtenOff",
  "createdDate",
];

// Default visible set covers the top-priority columns Jac asked for:
// Opp Owner, Stage, Amount (opp), Manager Probability, Risk-Adjusted
// Value, Scheduled Date, Payment Amount, Close Date — plus the always-
// useful Opportunity (with account beneath) and Paid status.
const DEFAULT_VISIBLE_COLS: ColKey[] = [
  "opportunity",
  "oppOwner",
  "stage",
  "oppAmount",
  "mgrProb",
  "riskAdjusted",
  "scheduledDate",
  "amount",
  "closeDate",
  "paid",
];

const COL_LABELS: Record<ColKey, string> = {
  paymentNumber: "Payment #",
  opportunity: "Opportunity",
  oppOwner: "Opp owner",
  stage: "Stage",
  recordType: "Record type",
  active: "Active",
  oppAmount: "Opp amount",
  mgrProb: "Mgr prob.",
  riskAdjusted: "Risk-adj",
  closeDate: "Close",
  amount: "Pmt amount",
  scheduledDate: "Scheduled",
  paymentDate: "Paid date",
  paid: "Paid",
  method: "Method",
  status: "Status",
  department: "Department",
  glAccount: "GL account",
  amountReceived: "Received",
  reconciled: "Reconciled",
  writtenOff: "Written off",
  createdDate: "Created",
};

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  paymentNumber: 110,
  opportunity: 260,
  oppOwner: 140,
  stage: 140,
  recordType: 140,
  active: 80,
  oppAmount: 120,
  mgrProb: 90,
  riskAdjusted: 120,
  closeDate: 110,
  amount: 120,
  scheduledDate: 110,
  paymentDate: 110,
  paid: 70,
  method: 120,
  status: 130,
  department: 200,
  glAccount: 220,
  amountReceived: 110,
  reconciled: 100,
  writtenOff: 100,
  createdDate: 110,
};

const ROW_HEIGHT = 44;

const PAYMENTS_REFERRER = {
  from: { pathname: "/payments", label: "Payments" },
} as const;

interface PaymentsSavedView {
  scope?: Scope;
  rules?: FilterRule<PaymentField>[];
  /** Visible column keys, in display order (drag-reorder persists here). */
  visibleCols?: ColKey[];
  widths?: Partial<Record<ColKey, number>>;
}

function extractPayment(p: SfPayment, key: ColKey): unknown {
  switch (key) {
    case "paymentNumber": return p.Name ?? "";
    case "opportunity": return p.npe01__Opportunity__r?.Name ?? "";
    case "oppOwner": return p.npe01__Opportunity__r?.Owner?.Name ?? "";
    case "stage": return p.npe01__Opportunity__r?.StageName ?? "";
    case "recordType": return p.npe01__Opportunity__r?.RecordType?.Name ?? "";
    case "active": return p.npe01__Opportunity__r?.Active_Opportunity__c ? 1 : 0;
    case "oppAmount": return p.npe01__Opportunity__r?.Amount ?? 0;
    case "mgrProb": return p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? p.npe01__Opportunity__r?.Probability ?? 0;
    case "riskAdjusted": return riskAdjusted(p) ?? 0;
    case "closeDate": return p.npe01__Opportunity__r?.CloseDate ?? "";
    case "amount": return p.npe01__Payment_Amount__c ?? 0;
    case "scheduledDate": return p.npe01__Scheduled_Date__c ?? "";
    case "paymentDate": return p.npe01__Payment_Date__c ?? "";
    case "paid": return p.npe01__Paid__c ? 1 : 0;
    case "method": return p.npe01__Payment_Method__c ?? "";
    case "status": return p.Paid_Status__c ?? p.Payment_Status__c ?? "";
    case "department": return p.Department__c ?? "";
    case "glAccount": return p.GL_Account__c ?? "";
    case "amountReceived": return p.Amount_Received__c ?? 0;
    case "reconciled": return p.Reconciled_with_Finance__c ? 1 : 0;
    case "writtenOff": return p.npe01__Written_Off__c ? 1 : 0;
    case "createdDate": return p.CreatedDate ?? "";
  }
}

const NUMERIC_COLS: Set<ColKey> = new Set([
  "oppAmount", "mgrProb", "riskAdjusted", "amount", "amountReceived",
  "scheduledDate", "paymentDate", "closeDate", "createdDate",
]);

const PAYMENT_CSV_COLUMNS: CsvColumn<SfPayment>[] = [
  { label: "SF Id", getValue: (p) => p.Id },
  { label: "Payment #", getValue: (p) => p.Name },
  { label: "Opportunity Id", getValue: (p) => p.npe01__Opportunity__c },
  { label: "Opportunity", getValue: (p) => p.npe01__Opportunity__r?.Name },
  { label: "Account", getValue: (p) => p.npe01__Opportunity__r?.Account?.Name },
  { label: "Opp Owner", getValue: (p) => p.npe01__Opportunity__r?.Owner?.Name },
  { label: "Stage", getValue: (p) => p.npe01__Opportunity__r?.StageName },
  { label: "Record Type", getValue: (p) => p.npe01__Opportunity__r?.RecordType?.Name },
  { label: "Active Opp", getValue: (p) => (p.npe01__Opportunity__r?.Active_Opportunity__c ? "Yes" : "No") },
  { label: "Opp Amount", getValue: (p) => p.npe01__Opportunity__r?.Amount ?? "" },
  { label: "Mgr Probability Override", getValue: (p) => p.npe01__Opportunity__r?.Manager_Probability_Override__c ?? "" },
  { label: "Probability", getValue: (p) => p.npe01__Opportunity__r?.Probability ?? "" },
  { label: "Risk-Adjusted Value", getValue: (p) => riskAdjusted(p) ?? "" },
  { label: "Close Date", getValue: (p) => isoDate(p.npe01__Opportunity__r?.CloseDate) },
  { label: "Payment Amount", getValue: (p) => p.npe01__Payment_Amount__c ?? "" },
  { label: "Scheduled Date", getValue: (p) => isoDate(p.npe01__Scheduled_Date__c) },
  { label: "Payment Date", getValue: (p) => isoDate(p.npe01__Payment_Date__c) },
  { label: "Paid", getValue: (p) => (p.npe01__Paid__c ? "Yes" : "No") },
  { label: "Method", getValue: (p) => p.npe01__Payment_Method__c },
  { label: "Status", getValue: (p) => p.Paid_Status__c ?? p.Payment_Status__c },
  { label: "Delinquent", getValue: (p) => (p.Delinquent__c ? "Yes" : "No") },
  { label: "Written Off", getValue: (p) => (p.npe01__Written_Off__c ? "Yes" : "No") },
  { label: "Write-off reason", getValue: (p) => p.Write_off_reason__c },
  { label: "Department", getValue: (p) => p.Department__c },
  { label: "GL Account", getValue: (p) => p.GL_Account__c },
  { label: "Reconciled", getValue: (p) => (p.Reconciled_with_Finance__c ? "Yes" : "No") },
  { label: "Amount Received", getValue: (p) => p.Amount_Received__c ?? "" },
  { label: "Amount Minus Received", getValue: (p) => p.Amount_Minus_Received__c ?? "" },
  { label: "Batch", getValue: (p) => p.Batch_Name__c },
  { label: "Check #", getValue: (p) => p.npe01__Check_Reference_Number__c },
  { label: "Created", getValue: (p) => isoDate(p.CreatedDate) },
];

function isoDate(v?: string | null): string {
  if (!v) return "";
  return v.slice(0, 10);
}

// ── Page ────────────────────────────────────────────────────────────────────

export function PaymentsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = usePayments();
  const updatePayment = useUpdateAnyPayment();
  const canEdit = usePerm("edit_all_opportunities");

  const payments = data ?? [];

  const [scope, setScope] = useState<Scope>("all");
  const [rules, setRules] = useState<FilterRule<PaymentField>[]>([]);
  const [q, setQ] = useState("");

  const { sort, toggle } = useSort<ColKey>({
    key: "scheduledDate",
    direction: "asc",
  });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:payments", COLUMN_ORDER, DEFAULT_VISIBLE_COLS);
  const { widths, startResize, replaceAll: replaceWidths } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:payments",
    DEFAULT_WIDTHS,
  );

  // Discovered values for select-filter dropdowns.
  const chipFacets = useMemo(() => {
    const methods = new Set<string>();
    const statuses = new Set<string>();
    const depts = new Set<string>();
    const gls = new Set<string>();
    const stages = new Set<string>();
    const recordTypes = new Set<string>();
    const owners = new Map<string, string>();
    for (const p of payments) {
      const o = p.npe01__Opportunity__r;
      if (p.npe01__Payment_Method__c) methods.add(p.npe01__Payment_Method__c);
      const st = p.Paid_Status__c ?? p.Payment_Status__c;
      if (st) statuses.add(st);
      if (p.Department__c) depts.add(p.Department__c);
      if (p.GL_Account__c) gls.add(p.GL_Account__c);
      if (o?.StageName) stages.add(o.StageName);
      if (o?.RecordType?.Name) recordTypes.add(o.RecordType.Name);
      if (o?.OwnerId && o.Owner?.Name && !owners.has(o.OwnerId)) {
        owners.set(o.OwnerId, o.Owner.Name);
      }
    }
    const yesNo = [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }];
    const toOpt = (s: Set<string>) =>
      Array.from(s).sort().map((v) => ({ value: v, label: v }));
    return {
      paid: yesNo,
      writtenOff: yesNo,
      delinquent: yesNo,
      reconciled: yesNo,
      active: yesNo,
      method: toOpt(methods),
      status: toOpt(statuses),
      department: toOpt(depts),
      glAccount: toOpt(gls),
      stage: toOpt(stages),
      recordType: toOpt(recordTypes),
      oppOwner: Array.from(owners.entries())
        .map(([id, name]) => ({ value: id, label: name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [payments]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filt = payments.filter((p) => {
      if (!inScope(p, scope)) return false;
      if (needle) {
        const o = p.npe01__Opportunity__r;
        const hay =
          (p.Name ?? "") + " " +
          (o?.Name ?? "") + " " +
          (o?.Account?.Name ?? "") + " " +
          (p.Batch_Name__c ?? "") + " " +
          (p.npe01__Check_Reference_Number__c ?? "");
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(p, r, PAYMENT_FILTERABLE)) return false;
      }
      return true;
    });
    return sortBy(filt, sort, extractPayment);
  }, [payments, scope, q, rules, sort]);

  const totals = useMemo(() => {
    let amount = 0, received = 0, riskAdj = 0;
    for (const p of filtered) {
      amount += p.npe01__Payment_Amount__c ?? 0;
      received += p.Amount_Received__c ?? 0;
      const ra = riskAdjusted(p);
      if (ra != null) riskAdj += ra;
    }
    return { amount, received, riskAdj };
  }, [filtered]);

  const savePatch = useCallback(
    async (id: string, patch: PaymentPatch) => {
      await updatePayment.mutateAsync({ id, patch });
    },
    [updatePayment],
  );

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  const tableMinWidth = totalWidth(widths);

  return (
    <div className="flex h-full flex-col px-7 py-6">
      <PageHeader
        title="Payments"
        subtitle={
          isLoading
            ? "Loading…"
            : `${filtered.length.toLocaleString()} of ${payments.length.toLocaleString()} · ${fmtMoney(totals.amount)} scheduled · ${fmtMoney(totals.riskAdj)} risk-adj · ${fmtMoney(totals.received)} received`
        }
      />

      {/* Toolbar */}
      <Toolbar className="mt-4">
        <ButtonGroup
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          options={SCOPES.map((s) => ({ value: s.value, label: s.label }))}
        />
        <div className="relative">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search opp, account, payment # …"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-72 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<PaymentField>
          filterable={PAYMENT_FILTERABLE as Record<PaymentField, FieldMeta<unknown>>}
          selectOptions={{
            paid: chipFacets.paid,
            writtenOff: chipFacets.writtenOff,
            delinquent: chipFacets.delinquent,
            reconciled: chipFacets.reconciled,
            active: chipFacets.active,
            method: chipFacets.method,
            status: chipFacets.status,
            department: chipFacets.department,
            glAccount: chipFacets.glAccount,
            stage: chipFacets.stage,
            recordType: chipFacets.recordType,
            oppOwner: chipFacets.oppOwner,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <div className="ml-auto flex items-center gap-2">
          <ExportCsvButton<SfPayment>
            rows={filtered}
            columns={PAYMENT_CSV_COLUMNS}
            baseFilename="payments"
          />
          <ColumnChooser
            allColumns={COLUMN_ORDER}
            labels={COL_LABELS}
            visible={visibleCols}
            required={["opportunity"]}
            onToggle={toggleCol}
          />
          <SavedViewsPicker<PaymentsSavedView>
            scopeKey="payments"
            currentFilters={{ scope, rules, visibleCols, widths }}
            onLoad={(v) => {
              setScope(v.scope ?? "all");
              setRules(v.rules ?? []);
              if (v.visibleCols && v.visibleCols.length > 0) replaceVisibleCols(v.visibleCols);
              if (v.widths && Object.keys(v.widths).length > 0) replaceWidths(v.widths);
            }}
          />
        </div>
      </Toolbar>

      {/* Active chip row */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, PAYMENT_FILTERABLE)}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="ml-1 text-[11px] font-medium text-ink-3 hover:text-accent"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Table */}
      <div
        ref={scrollRef}
        className="relative mt-0 flex-1 overflow-auto border border-border-strong bg-surface"
      >
        <table
          className="table-fixed border-collapse text-[12.5px]"
          style={{ minWidth: tableMinWidth }}
        >
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-10 border-b border-border-strong bg-surface-2 text-[11px] uppercase tracking-wider text-ink-3">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align={NUMERIC_COLS.has(key) ? "right" : "left"}
                  isLast={idx === visibleCols.length - 1}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-ink-3">
                  Loading payments…
                </td>
              </tr>
            ) : isError ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-red">
                  Failed to load payments
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-7 py-10 text-center text-[13px] text-ink-3">
                  {payments.length === 0
                    ? "No payments. (Is Salesforce connected?)"
                    : "No payments match your filters."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const p = filtered[vi.index];
                  return (
                    <PaymentRow
                      key={p.Id}
                      p={p}
                      visibleCols={visibleCols}
                      canEdit={canEdit}
                      onSave={savePatch}
                      onOpenOpp={(oppId) =>
                        navigate(`/opportunities/${oppId}`, { state: PAYMENTS_REFERRER })
                      }
                    />
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={visibleCols.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

interface RowProps {
  p: SfPayment;
  visibleCols: ColKey[];
  canEdit: boolean;
  onSave: (id: string, patch: PaymentPatch) => Promise<void>;
  onOpenOpp: (oppId: string) => void;
}

const METHOD_OPTIONS = [
  { value: "", label: "—" },
  ...PAYMENT_METHODS.map((m) => ({ value: m, label: m })),
];

const DEPARTMENT_OPTIONS = [
  { value: "", label: "—" },
  ...DEPARTMENTS.map((d) => ({ value: d, label: d })),
];

const GL_OPTIONS = [
  { value: "", label: "—" },
  ...GL_ACCOUNTS.map((g) => ({ value: g, label: g })),
];

const YESNO_OPTIONS = [
  { value: "false", label: "No" },
  { value: "true", label: "Yes" },
];

function moneyDisplay(raw: string): string {
  const n = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? fmtMoneyFull(n) : raw;
}

const PaymentRow = memo(function PaymentRow({
  p, visibleCols, canEdit, onSave, onOpenOpp,
}: RowProps) {
  const opp = p.npe01__Opportunity__r;
  const accountName = opp?.Account?.Name ?? "—";
  const probDisplay =
    opp?.Manager_Probability_Override__c ?? opp?.Probability ?? null;
  const ra = riskAdjusted(p);

  const cells: Partial<Record<ColKey, React.ReactNode>> = {
    paymentNumber: <span className="truncate font-mono text-[11.5px] text-ink-3">{p.Name ?? "—"}</span>,
    opportunity: (
      <div className="flex min-w-0 items-center gap-1.5">
        <AccountAvatar name={accountName} logoUrl={null} size={18} />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <button
            type="button"
            onClick={() => p.npe01__Opportunity__c && onOpenOpp(p.npe01__Opportunity__c)}
            className="truncate text-left font-medium text-ink hover:underline"
            title={opp?.Name ?? ""}
          >
            {opp?.Name ?? p.npe01__Opportunity__c ?? "—"}
          </button>
          <span className="truncate text-[11px] text-ink-3" title={accountName}>{accountName}</span>
        </div>
      </div>
    ),
    oppOwner: <span className="truncate text-ink-2">{opp?.Owner?.Name ?? "—"}</span>,
    stage: <span className="truncate text-ink-2">{opp?.StageName ?? "—"}</span>,
    recordType: <span className="truncate text-ink-2">{opp?.RecordType?.Name ?? "—"}</span>,
    active: (
      <span className="text-ink-2">{opp?.Active_Opportunity__c ? "Yes" : "—"}</span>
    ),
    oppAmount: (
      <span className="block text-right tabular-nums text-ink-2">
        {opp?.Amount != null ? fmtMoney(opp.Amount) : "—"}
      </span>
    ),
    mgrProb: (
      <span className="block text-right tabular-nums text-ink-2">
        {probDisplay != null ? `${probDisplay}%` : "—"}
      </span>
    ),
    riskAdjusted: (
      <span className="block text-right tabular-nums text-ink-2">
        {ra != null ? fmtMoney(ra) : "—"}
      </span>
    ),
    closeDate: (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(opp?.CloseDate)}</span>
    ),
    amount: canEdit ? (
      <InlineText
        value={p.npe01__Payment_Amount__c != null ? String(p.npe01__Payment_Amount__c) : ""}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Amount__c: v ? Number(v.replace(/[^0-9.-]/g, "")) : 0 })}
        formatDisplay={moneyDisplay}
        placeholder="—"
        className="justify-end text-right"
      />
    ) : (
      <span className="block text-right tabular-nums">
        {p.npe01__Payment_Amount__c != null ? fmtMoney(p.npe01__Payment_Amount__c) : "—"}
      </span>
    ),
    scheduledDate: canEdit ? (
      <InlineDate
        value={p.npe01__Scheduled_Date__c}
        onSave={(v) => onSave(p.Id, { npe01__Scheduled_Date__c: v })}
        placeholder="—"
        align="right"
      />
    ) : (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(p.npe01__Scheduled_Date__c)}</span>
    ),
    paymentDate: canEdit ? (
      <InlineDate
        value={p.npe01__Payment_Date__c}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Date__c: v })}
        placeholder="—"
        align="right"
      />
    ) : (
      <span className="block text-right tabular-nums text-ink-2">{fmtDate(p.npe01__Payment_Date__c)}</span>
    ),
    paid: canEdit ? (
      <InlineSelect
        value={p.npe01__Paid__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Paid__c: v === "true" })}
        renderValue={(v) => (
          <span className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium",
            v === "true"
              ? "border-green bg-green-soft text-green"
              : "border-border-strong bg-surface-2 text-ink-3",
          )}>
            {v === "true" ? "Paid" : "—"}
          </span>
        )}
      />
    ) : p.npe01__Paid__c ? (
      <span className="inline-flex items-center rounded border border-green bg-green-soft px-1.5 py-0.5 text-[10.5px] font-medium text-green">
        Paid
      </span>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    method: canEdit ? (
      <InlineSelect
        value={p.npe01__Payment_Method__c ?? ""}
        options={METHOD_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Payment_Method__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.npe01__Payment_Method__c ?? "—"}</span>
    ),
    status: (
      <span className="truncate text-ink-2">
        {p.Paid_Status__c ?? p.Payment_Status__c ?? "—"}
      </span>
    ),
    department: canEdit ? (
      <InlineSelect
        value={p.Department__c ?? ""}
        options={DEPARTMENT_OPTIONS}
        onSave={(v) => onSave(p.Id, { Department__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.Department__c ?? "—"}</span>
    ),
    glAccount: canEdit ? (
      <InlineSelect
        value={p.GL_Account__c ?? ""}
        options={GL_OPTIONS}
        onSave={(v) => onSave(p.Id, { GL_Account__c: v || null })}
        renderValue={(v) => <span className="truncate text-ink-2">{v || "—"}</span>}
      />
    ) : (
      <span className="truncate text-ink-2">{p.GL_Account__c ?? "—"}</span>
    ),
    amountReceived: (
      <span className="block text-right tabular-nums text-ink-2">
        {p.Amount_Received__c != null ? fmtMoney(p.Amount_Received__c) : "—"}
      </span>
    ),
    reconciled: canEdit ? (
      <InlineSelect
        value={p.Reconciled_with_Finance__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { Reconciled_with_Finance__c: v === "true" })}
        renderValue={(v) => (
          <span className="text-ink-2">{v === "true" ? "Yes" : "—"}</span>
        )}
      />
    ) : (
      <span className="text-ink-2">{p.Reconciled_with_Finance__c ? "Yes" : "—"}</span>
    ),
    writtenOff: canEdit ? (
      <InlineSelect
        value={p.npe01__Written_Off__c ? "true" : "false"}
        options={YESNO_OPTIONS}
        onSave={(v) => onSave(p.Id, { npe01__Written_Off__c: v === "true" })}
        renderValue={(v) => (
          <span className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10.5px] font-medium",
            v === "true"
              ? "border-amber bg-amber-soft text-amber"
              : "border-border-strong bg-surface-2 text-ink-3",
          )}>
            {v === "true" ? "Written off" : "—"}
          </span>
        )}
      />
    ) : p.npe01__Written_Off__c ? (
      <span className="inline-flex items-center rounded border border-amber bg-amber-soft px-1.5 py-0.5 text-[10.5px] font-medium text-amber">
        Written off
      </span>
    ) : (
      <span className="text-ink-4">—</span>
    ),
    createdDate: (
      <span className="block text-right tabular-nums text-ink-3">{fmtDate(p.CreatedDate)}</span>
    ),
  };

  return (
    <tr className="border-b border-border-strong hover:bg-surface-2/50" style={{ height: ROW_HEIGHT }}>
      {visibleCols.map((key) => (
        <td key={key} className="overflow-hidden px-3 py-1.5">
          {cells[key]}
        </td>
      ))}
    </tr>
  );
});
