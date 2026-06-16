import { useState } from "react";
import { Plus, X, Check, Trash2, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useBuilders, type Builder } from "@/services/jobs";
import {
  useOppRoles,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  useHireRole,
  type Role,
  type RoleStatus,
} from "@/services/jobsOpps2";

// ── Helpers ────────────────────────────────────────────────────────────────

const ROLE_STATUS_STYLES: Record<RoleStatus, string> = {
  open:      "bg-amber-50 text-amber-700",
  filled:    "bg-green-100 text-green-800",
  cancelled: "bg-stone-100 text-stone-500",
};

const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  open:      "Open",
  filled:    "Filled",
  cancelled: "Cancelled",
};

function fmtSalary(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin text-ink-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Hire inline form ─────────────────────────────────────────────────────────

function HireForm({ role, oppId, onClose }: { role: Role; oppId: string; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [salary, setSalary] = useState(role.approx_salary != null ? String(role.approx_salary) : "");
  const [startDate, setStartDate] = useState(role.start_date ?? "");

  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];
  const hire = useHireRole();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    hire.mutate(
      {
        roleId: role.id,
        oppId,
        user_id: builder.user_id,
        salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
        start_date: startDate || undefined,
        employment_type: role.employment_type ?? undefined,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mt-2 flex flex-col gap-2 rounded-md border border-border-strong bg-surface-2/40 p-2.5"
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
        Hire a builder
      </span>

      {/* Builder picker */}
      {builder ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11.5px] text-ink-2">
          {builder.name}
          <button
            type="button"
            onClick={() => { setBuilder(null); setSearch(""); }}
            className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
            title="Clear builder"
          >
            <X size={11} />
          </button>
        </span>
      ) : (
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
          {open && builders.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
              {builders.slice(0, 12).map((b: Builder) => (
                <li key={b.user_id}>
                  <button
                    type="button"
                    onMouseDown={() => {
                      setBuilder({ user_id: b.user_id, name: b.name });
                      setOpen(false);
                      setSearch("");
                    }}
                    className="w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
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

      {/* Salary + start override */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] font-medium text-ink-4">Salary</label>
          <input
            type="number"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="85000"
            min={0}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] font-medium text-ink-4">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!builder || hire.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {hire.isPending ? <Spinner /> : <Check size={12} />}
          {hire.isPending ? "Hiring…" : "Confirm hire"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[11.5px] text-ink-3 hover:text-ink-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Single role row ───────────────────────────────────────────────────────────

function RoleRow({ role, oppId }: { role: Role; oppId: string }) {
  const [editing, setEditing] = useState(false);
  const [hiring, setHiring] = useState(false);
  const [title, setTitle] = useState(role.title);
  const [salary, setSalary] = useState(role.approx_salary != null ? String(role.approx_salary) : "");
  const [empType, setEmpType] = useState(role.employment_type ?? "");
  const [startDate, setStartDate] = useState(role.start_date ?? "");

  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();

  function saveEdit() {
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : null;
    updateRole.mutate(
      {
        roleId: role.id,
        oppId,
        title: title.trim() || role.title,
        approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : null,
        employment_type: empType.trim() || null,
        start_date: startDate || null,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-2 px-3 py-2.5">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Role title"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <div className="grid grid-cols-3 gap-2">
          <input
            type="number"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="Salary"
            min={0}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          <input
            type="text"
            value={empType}
            onChange={(e) => setEmpType(e.target.value)}
            placeholder="Type"
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={saveEdit}
            disabled={updateRole.isPending}
            className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {updateRole.isPending ? <Spinner /> : <Check size={12} />}
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[11.5px] text-ink-3 hover:text-ink-2"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-ink">{role.title}</span>
          <span className="truncate text-[11.5px] text-ink-3">
            {[fmtSalary(role.approx_salary), role.employment_type, role.start_date ? fmtDate(role.start_date) : null]
              .filter((x) => x && x !== "—")
              .join(" · ") || "—"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
              ROLE_STATUS_STYLES[role.status],
            )}
          >
            {ROLE_STATUS_LABELS[role.status]}
          </span>
          {role.status === "open" && (
            <button
              type="button"
              onClick={() => setHiring((v) => !v)}
              title="Hire a builder"
              className="flex items-center gap-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
            >
              <UserPlus size={11} />
              Hire
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[10.5px] text-ink-3 hover:text-accent"
          >
            Edit
          </button>
          <button
            type="button"
            title="Delete role"
            onClick={() => {
              if (window.confirm(`Delete the "${role.title ?? "untitled"}" role? This can't be undone.`)) {
                deleteRole.mutate({ roleId: role.id, oppId });
              }
            }}
            className="text-ink-4 hover:text-red-500 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {hiring && role.status === "open" && (
        <HireForm role={role} oppId={oppId} onClose={() => setHiring(false)} />
      )}
    </li>
  );
}

// ── Add-role inline form ───────────────────────────────────────────────────────

function AddRoleForm({ oppId }: { oppId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [salary, setSalary] = useState("");
  const [empType, setEmpType] = useState("");
  const [startDate, setStartDate] = useState("");
  const createRole = useCreateRole();

  function reset() {
    setTitle("");
    setSalary("");
    setEmpType("");
    setStartDate("");
    setOpen(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const salaryNum = salary.trim() ? Number(salary.replace(/[^0-9.]/g, "")) : undefined;
    createRole.mutate(
      {
        oppId,
        title: title.trim(),
        approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
        employment_type: empType.trim() || undefined,
        start_date: startDate || undefined,
      },
      { onSuccess: () => reset() },
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-[12px] text-accent hover:underline"
      >
        + Add role
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border-strong p-2.5">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Role title"
        autoFocus
        className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      <div className="grid grid-cols-3 gap-2">
        <input
          type="number"
          value={salary}
          onChange={(e) => setSalary(e.target.value)}
          placeholder="Salary"
          min={0}
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <input
          type="text"
          value={empType}
          onChange={(e) => setEmpType(e.target.value)}
          placeholder="Type"
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!title.trim() || createRole.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {createRole.isPending ? <Spinner /> : <Plus size={12} />}
          Add role
        </button>
        <button type="button" onClick={reset} className="text-[11.5px] text-ink-3 hover:text-ink-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Section ────────────────────────────────────────────────────────────────────

export function OppRolesSection({ oppId }: { oppId: string }) {
  const rolesQ = useOppRoles(oppId);
  const roles = rolesQ.data ?? [];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">Committed Roles</span>
      {rolesQ.isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : roles.length === 0 ? (
        <span className="text-[12px] text-ink-4">No roles committed yet.</span>
      ) : (
        <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
          {roles.map((r) => (
            <RoleRow key={r.id} role={r} oppId={oppId} />
          ))}
        </ul>
      )}
      <AddRoleForm oppId={oppId} />
    </div>
  );
}
