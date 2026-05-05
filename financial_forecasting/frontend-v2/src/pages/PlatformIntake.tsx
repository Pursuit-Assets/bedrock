import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Bug, Lightbulb, Paperclip, X } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { useCurrentUser } from "@/services/auth";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type IntakeType = "bug" | "feature";
type Priority = "urgent" | "high" | "medium" | "low";

const COMPONENTS: { value: string; label: string }[] = [
  { value: "priorities",      label: "Priorities" },
  { value: "details",         label: "Details (tables)" },
  { value: "progress",        label: "Progress" },
  { value: "opportunities",   label: "Opportunities" },
  { value: "accounts",        label: "Accounts" },
  { value: "contacts",        label: "Contacts" },
  { value: "leads",           label: "Leads" },
  { value: "tasks",           label: "Tasks" },
  { value: "salesforce_sync", label: "Salesforce sync" },
  { value: "other",           label: "Other" },
];

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "urgent", label: "Urgent — blocks me right now" },
  { value: "high",   label: "High — blocks me this week" },
  { value: "medium", label: "Medium — important, workaround exists" },
  { value: "low",    label: "Low — nice to have" },
];

const ACCEPT_ATTR =
  "image/png,image/jpeg,image/gif,image/webp,video/quicktime,video/mp4,application/pdf";
const MAX_UPLOAD_MB = 25;

export function PlatformIntakePage() {
  const { data: user } = useCurrentUser();

  const [type, setType] = useState<IntakeType>("bug");
  const [reporterName, setReporterName] = useState(user?.name ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [component, setComponent] = useState("");
  const [priority, setPriority] = useState<Priority | "">("");
  const [justification, setJustification] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reporterEmail = user?.email ?? "";

  const disabled = useMemo(
    () => submitting || !title.trim() || !description.trim() || !component || !priority,
    [submitting, title, description, component, priority],
  );

  const reset = () => {
    setTitle("");
    setDescription("");
    setComponent("");
    setPriority("");
    setJustification("");
    setAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`File exceeds ${MAX_UPLOAD_MB} MB — please attach a smaller version.`);
      e.target.value = "";
      setAttachment(null);
      return;
    }
    setAttachment(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;

    const fd = new FormData();
    fd.append("type", type);
    fd.append("title", title.trim());
    fd.append("description", description.trim());
    fd.append("platform_component", component);
    fd.append("recommended_prioritization", priority);
    fd.append("prioritization_justification", justification.trim());
    fd.append("reporter_name", reporterName.trim() || (user?.name ?? ""));
    if (attachment) fd.append("attachment", attachment);

    setSubmitting(true);
    try {
      const res = await api.post<{ id: string; upload_url: string | null }>(
        "/api/platform-intake",
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      toast.success(type === "bug" ? "Bug submitted — thank you!" : "Feature request submitted — thank you!");
      setLastId(res.data.id);
      reset();
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? "Submission failed.";
      toast.error(String(detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[820px] px-7 py-6 pb-20">
      <PageHeader
        title="Bug reports & feature requests"
        subtitle="Submissions go to the product team alongside intake from the rest of the Pursuit platform. Screenshots welcome."
      />

      {lastId && (
        <div className="mb-5 flex items-center gap-2 rounded-md border border-green/30 bg-green/10 px-4 py-2.5 text-[13px] text-ink">
          <span className="flex-1">
            Submitted as <span className="font-mono font-medium">#{lastId.slice(0, 8)}</span>
          </span>
          <button
            type="button"
            onClick={() => setLastId(null)}
            className="text-ink-3 hover:text-ink"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-surface-2 p-6">
        <div className="flex flex-col gap-4">
          {/* Type toggle */}
          <div className="flex gap-2">
            {(["bug", "feature"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors",
                  type === t
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border-strong bg-surface text-ink-2 hover:text-ink",
                )}
              >
                {t === "bug" ? <Bug size={14} /> : <Lightbulb size={14} />}
                {t === "bug" ? "Bug" : "Feature"}
              </button>
            ))}
          </div>

          {/* Email + name */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Your email">
              <input
                type="text"
                value={reporterEmail}
                readOnly
                className="w-full rounded border border-border-strong bg-surface-2 px-3 py-2 text-[13px] text-ink-3 outline-none"
              />
            </Field>
            <Field label="Your name">
              <input
                type="text"
                value={reporterName}
                onChange={(e) => setReporterName(e.target.value)}
                placeholder={user?.name ?? ""}
                className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              />
            </Field>
          </div>

          {/* Title */}
          <Field label={type === "bug" ? "Short summary of the bug *" : "Short summary of the feature *"}>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
            />
          </Field>

          {/* Description */}
          <Field
            label={
              type === "bug"
                ? "What happened? What did you expect? Steps to reproduce? *"
                : "What would you like to see, and why? *"
            }
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
              rows={4}
              required
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent resize-none"
            />
          </Field>

          {/* Attachment */}
          <div className="flex items-center gap-3 rounded-md border border-dashed border-border-strong px-4 py-3 flex-wrap">
            <Paperclip size={15} className="flex-shrink-0 text-ink-3" />
            <div className="flex-1 min-w-[160px]">
              <p className="text-[13px] font-medium text-ink">Screenshot or recording (optional)</p>
              <p className="text-[11.5px] text-ink-3">PNG, JPG, GIF, WebP, MOV, MP4, PDF · Max {MAX_UPLOAD_MB} MB</p>
            </div>
            {attachment && (
              <span className="flex items-center gap-1 rounded-full bg-surface border border-border-strong px-2.5 py-0.5 text-[12px] text-ink-2">
                {attachment.name} ({Math.round(attachment.size / 1024)} KB)
                <button
                  type="button"
                  onClick={() => { setAttachment(null); if (fileRef.current) fileRef.current.value = ""; }}
                  className="ml-0.5 text-ink-3 hover:text-ink"
                  aria-label="Remove attachment"
                >
                  <X size={12} />
                </button>
              </span>
            )}
            <label className="cursor-pointer rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-surface-2">
              {attachment ? "Replace" : "Choose file"}
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_ATTR}
                onChange={handleFile}
                className="sr-only"
              />
            </label>
          </div>

          {/* Component + Priority */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Which part of Bedrock? *">
              <select
                value={component}
                onChange={(e) => setComponent(e.target.value)}
                required
                className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              >
                <option value="" disabled>Select…</option>
                {COMPONENTS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Recommended priority *">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                required
                className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              >
                <option value="" disabled>Select…</option>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Justification */}
          <Field label="Why that priority? (optional)">
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              maxLength={2000}
              rows={2}
              className="input-base resize-none"
            />
          </Field>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={submitting}
              className="rounded-md border border-border-strong px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:text-ink disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="submit"
              disabled={disabled}
              className="rounded-md bg-ink px-4 py-1.5 text-[13px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
            >
              {submitting ? "Submitting…" : type === "bug" ? "Submit bug" : "Submit request"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}
