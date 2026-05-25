/**
 * Generic chip-based filter system used by the Cleanup tabs (accounts,
 * contacts, and — eventually — opportunities). Each tab provides:
 *   - a `FILTERABLE` config: per-field metadata (label, type, getValue)
 *   - a per-rule `valueOptions` lookup for select-typed fields
 *   - an optional value-renderer for chip labels (e.g. owner id → name)
 *
 * The shared module owns the rule shape, operator catalog, AddFilterButton
 * dropdown UI, FilterChip pill, and pure `ruleApplies` / `describeRule`
 * helpers — keeping each Cleanup tab focused on entity-specific bits.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Filter as FilterIcon, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

export type FieldType = "select" | "text" | "number" | "date";

export type Operator =
  | "equals"
  | "not_equals"
  | "is_empty"
  | "is_not_empty"
  | "contains"
  | "gt"
  | "lt"
  | "before"
  | "after";

export interface FieldMeta<T> {
  label: string;
  type: FieldType;
  getValue: (item: T) => string | number | null | undefined;
}

export interface FilterRule<F extends string = string> {
  id: string;
  field: F;
  op: Operator;
  /** Multi-value capable. For select+equals, any listed value matches.
   *  For text/number/date ops only `values[0]` is consulted. */
  values: string[];
}

export const OPS_BY_TYPE: Record<FieldType, { value: Operator; label: string }[]> = {
  select: [
    { value: "equals", label: "is" },
    { value: "not_equals", label: "is not" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "has any value" },
  ],
  text: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "is" },
    { value: "not_equals", label: "is not" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "has any value" },
  ],
  number: [
    { value: "equals", label: "=" },
    { value: "not_equals", label: "≠" },
    { value: "gt", label: ">" },
    { value: "lt", label: "<" },
    { value: "is_empty", label: "is empty" },
  ],
  date: [
    { value: "before", label: "before" },
    { value: "after", label: "after" },
    { value: "equals", label: "is" },
    { value: "not_equals", label: "is not" },
    { value: "is_empty", label: "is empty" },
  ],
};

/** Pure predicate — does `item` satisfy filter rule `r`? Caller passes
 *  the same FILTERABLE config used by the AddFilterButton. */
export function ruleApplies<T, F extends string>(
  item: T,
  r: FilterRule<F>,
  filterable: Record<F, FieldMeta<T>>,
): boolean {
  const meta = filterable[r.field];
  if (!meta) return true;
  const v = meta.getValue(item);

  if (r.op === "is_empty") return v == null || v === "";
  if (r.op === "is_not_empty") return v != null && v !== "";

  const first = r.values[0] ?? "";

  if (meta.type === "select") {
    if (r.op === "equals" || r.op === "not_equals") {
      if (r.values.length === 0) return true;
      const inSet = r.values.includes(String(v ?? ""));
      return r.op === "equals" ? inSet : !inSet;
    }
  }

  if (meta.type === "text") {
    const s = String(v ?? "").toLowerCase();
    const f = first.toLowerCase();
    if (r.op === "contains") return s.includes(f);
    if (r.op === "equals") return s === f;
    if (r.op === "not_equals") return s !== f;
  }

  if (meta.type === "number") {
    if (v == null || first === "") return false;
    const n = Number(v);
    const target = Number(first);
    if (!Number.isFinite(target)) return false;
    if (r.op === "gt") return n > target;
    if (r.op === "lt") return n < target;
    if (r.op === "equals") return n === target;
    if (r.op === "not_equals") return n !== target;
  }

  if (meta.type === "date") {
    if (v == null || first === "") return false;
    const ms = new Date(String(v)).getTime();
    const target = new Date(first).getTime();
    if (!Number.isFinite(ms) || !Number.isFinite(target)) return false;
    if (r.op === "before") return ms < target;
    if (r.op === "after") return ms > target;
    if (r.op === "equals") return String(v).slice(0, 10) === first;
    if (r.op === "not_equals") return String(v).slice(0, 10) !== first;
  }

  return true;
}

export function describeRule<T, F extends string>(
  r: FilterRule<F>,
  filterable: Record<F, FieldMeta<T>>,
  /** Optional value-label resolver per field (e.g. owner id → display name). */
  renderValue?: (field: F, value: string) => string,
): string {
  const meta = filterable[r.field];
  if (!meta) return "(unknown filter)";
  if (r.op === "is_empty") return `${meta.label} is empty`;
  if (r.op === "is_not_empty") return `${meta.label} has any value`;
  const opLabel =
    OPS_BY_TYPE[meta.type].find((o) => o.value === r.op)?.label ?? r.op;
  // Empty-string values come from the "(empty)" sentinel in the
  // multi-select picker — display them as "(empty)" so the chip
  // reads as e.g. "Philanthropy type is not (empty)" instead of a
  // trailing blank.
  const render = (v: string) => {
    const raw = renderValue ? renderValue(r.field, v) : v;
    return raw === "" ? "(empty)" : raw;
  };
  let valLabel: string;
  if (r.values.length <= 1) {
    valLabel = render(r.values[0] ?? "");
  } else if (r.values.length === 2) {
    valLabel = `${render(r.values[0])}, ${render(r.values[1])}`;
  } else {
    valLabel = `${render(r.values[0])}, ${render(r.values[1])} +${r.values.length - 2} more`;
  }
  return `${meta.label} ${opLabel} ${valLabel}`;
}

// ── Chip + add-filter button ─────────────────────────────────────────────

export function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  // Match the toolbar ButtonGroup pill exactly: h-7, text-[12.5px]
  // font-medium, border-border-strong on bg-surface. No leading
  // accent dot — the page's pill family is flat by convention.
  return (
    <span className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border-strong bg-surface pl-2.5 pr-1 text-[12.5px] font-medium text-ink-2">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="grid h-5 w-5 flex-shrink-0 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
        aria-label="Remove filter"
      >
        <X size={11} aria-hidden="true" />
      </button>
    </span>
  );
}

export interface AddFilterButtonProps<F extends string> {
  filterable: Record<F, FieldMeta<unknown>>;
  /** For select-type fields: option list per field. Undefined for text/
   *  number/date inputs. */
  selectOptions: Partial<Record<F, { value: string; label: string }[]>>;
  onAdd: (rule: FilterRule<F>) => void;
  /** Override the trigger button text. Default: "Add filter". */
  buttonLabel?: string;
}

export function AddFilterButton<F extends string>({
  filterable,
  selectOptions,
  onAdd,
  buttonLabel = "Add filter",
}: AddFilterButtonProps<F>) {
  const fieldKeys = useMemo(() => Object.keys(filterable) as F[], [filterable]);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<F>(fieldKeys[0]);
  const meta = filterable[field];
  const ops = OPS_BY_TYPE[meta.type];
  const [op, setOp] = useState<Operator>(ops[0].value);
  const [singleValue, setSingleValue] = useState("");
  const [multiValues, setMultiValues] = useState<string[]>([]);
  const [pickerQ, setPickerQ] = useState("");

  const needsValue = op !== "is_empty" && op !== "is_not_empty";
  // Both "is" and "is not" use the multi-select picker so users can
  // pick any combination of values (or exclude a combination).
  const isMultiSelect =
    meta.type === "select" && (op === "equals" || op === "not_equals");
  const rawValueOptions = selectOptions[field] ?? null;

  // Inject an explicit "(empty)" sentinel at the top of every
  // select multi-select so the user can include / exclude rows where
  // the field is null/empty alongside concrete values. ruleApplies()
  // already normalizes null → "" so this just needs the empty-string
  // option in the value list.
  const valueOptions = useMemo(() => {
    if (!rawValueOptions) return null;
    return [{ value: "", label: "(empty)" }, ...rawValueOptions];
  }, [rawValueOptions]);

  const filteredOptions = useMemo(() => {
    if (!valueOptions) return null;
    if (!pickerQ.trim()) return valueOptions;
    const needle = pickerQ.toLowerCase();
    return valueOptions.filter((o) => o.label.toLowerCase().includes(needle));
  }, [valueOptions, pickerQ]);

  const reset = () => {
    setField(fieldKeys[0]);
    setOp(OPS_BY_TYPE[filterable[fieldKeys[0]].type][0].value);
    setSingleValue("");
    setMultiValues([]);
    setPickerQ("");
  };

  const handleAdd = () => {
    // crypto.randomUUID is collision-safe even when the user smashes
    // the Add button — Date.now() granularity (1ms) was racey enough
    // that adjacent clicks could mint the same id.
    const newId = () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${field}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!needsValue) {
      onAdd({ id: newId(), field, op, values: [] });
    } else if (isMultiSelect) {
      if (multiValues.length === 0) return;
      onAdd({ id: newId(), field, op, values: multiValues });
    } else {
      if (!singleValue) return;
      onAdd({ id: newId(), field, op, values: [singleValue] });
    }
    reset();
    setOpen(false);
  };

  const toggleMulti = (v: string) => {
    setMultiValues((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
    );
  };

  // Portal + position:fixed so the popover escapes every clipping
  // ancestor (AppShell's <main> overflow-hidden, page wrappers, etc.)
  // and renders directly against the viewport. Recompute on open and
  // on scroll/resize so it tracks the trigger.
  const POPOVER_WIDTH = 320;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  const recomputePos = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewport = window.innerWidth;
    const margin = 8;
    let left = rect.left;
    if (left + POPOVER_WIDTH > viewport - margin) {
      left = Math.max(margin, rect.right - POPOVER_WIDTH);
    }
    setPopoverPos({ top: rect.bottom + 4, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    recomputePos();
    const onScroll = () => recomputePos();
    const onResize = () => recomputePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Close on click-outside (the popover lives in a portal, so a parent
  // click handler can't see clicks inside it — we listen on document).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border-strong bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2"
      >
        <FilterIcon size={12} aria-hidden="true" />
        <span>{buttonLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && popoverPos
        ? createPortal(
            <div
              ref={popoverRef}
              style={{ position: "fixed", top: popoverPos.top, left: popoverPos.left, width: POPOVER_WIDTH }}
              className="z-50 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl"
            >
              <div className="border-b border-border-strong bg-surface-2 px-3 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                New filter
              </div>
              <div className="flex flex-col gap-3 p-3">
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Field</span>
                  <select
                    value={field}
                    onChange={(e) => {
                      const next = e.target.value as F;
                      setField(next);
                      const firstOp = OPS_BY_TYPE[filterable[next].type][0].value;
                      setOp(firstOp);
                      setSingleValue("");
                      setMultiValues([]);
                      setPickerQ("");
                    }}
                    className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    {fieldKeys.map((k) => (
                      <option key={k} value={k}>
                        {filterable[k].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Condition</span>
                  <select
                    value={op}
                    onChange={(e) => {
                      setOp(e.target.value as Operator);
                      setSingleValue("");
                      setMultiValues([]);
                    }}
                    className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    {ops.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {needsValue && !isMultiSelect ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Value</span>
                    {valueOptions ? (
                      <select
                        value={singleValue}
                        onChange={(e) => setSingleValue(e.target.value)}
                        className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
                      >
                        <option value="">—</option>
                        {valueOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : meta.type === "date" ? (
                      <input
                        type="date"
                        value={singleValue}
                        onChange={(e) => setSingleValue(e.target.value)}
                        className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
                      />
                    ) : meta.type === "number" ? (
                      <input
                        type="number"
                        value={singleValue}
                        onChange={(e) => setSingleValue(e.target.value)}
                        placeholder="0"
                        className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
                      />
                    ) : (
                      <input
                        type="text"
                        value={singleValue}
                        onChange={(e) => setSingleValue(e.target.value)}
                        placeholder="Enter a value…"
                        className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
                      />
                    )}
                  </label>
                ) : null}

                {isMultiSelect && valueOptions ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Values</span>
                    <div className="rounded border border-border-strong">
                      <div className="flex items-center justify-between border-b border-border-strong px-2 py-1.5">
                        <input
                          autoFocus
                          type="text"
                          value={pickerQ}
                          onChange={(e) => setPickerQ(e.target.value)}
                          placeholder={`Search ${meta.label.toLowerCase()}…`}
                          className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-4"
                        />
                        <span className="ml-2 flex-shrink-0 text-[11px] text-ink-3">
                          {multiValues.length} selected
                        </span>
                      </div>
                      <div className="max-h-[220px] overflow-y-auto">
                        {filteredOptions && filteredOptions.length > 0 ? (
                          filteredOptions.map((o) => {
                            const checked = multiValues.includes(o.value);
                            return (
                              <label
                                key={o.value}
                                className={cn(
                                  "flex cursor-pointer items-center gap-2 px-2 py-1 text-[12.5px] hover:bg-surface-2",
                                  checked && "bg-accent/5",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleMulti(o.value)}
                                  className="h-3.5 w-3.5 flex-shrink-0 cursor-pointer accent-accent"
                                />
                                <span className="min-w-0 flex-1 truncate text-ink" title={o.label}>
                                  {o.label}
                                </span>
                              </label>
                            );
                          })
                        ) : (
                          <div className="px-2 py-2 text-center text-[11.5px] text-ink-3">
                            No matches
                          </div>
                        )}
                      </div>
                      {multiValues.length > 0 ? (
                        <div className="flex items-center justify-between border-t border-border-strong px-2 py-1">
                          <button
                            type="button"
                            onClick={() => setMultiValues([])}
                            className="text-[11.5px] text-ink-3 hover:text-ink-2"
                          >
                            Clear
                          </button>
                          <button
                            type="button"
                            onClick={() => filteredOptions && setMultiValues(filteredOptions.map((o) => o.value))}
                            className="text-[11.5px] text-ink-3 hover:text-ink-2"
                          >
                            Select all{pickerQ ? " filtered" : ""}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="mt-1 flex items-center justify-end gap-2 border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => { reset(); setOpen(false); }}
                    className="text-[12px] text-ink-3 hover:text-ink-2"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={
                      needsValue &&
                      (isMultiSelect ? multiValues.length === 0 : !singleValue)
                    }
                    className="inline-flex h-8 items-center gap-1 rounded bg-ink px-3 text-[12px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Plus size={12} /> Add filter
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
