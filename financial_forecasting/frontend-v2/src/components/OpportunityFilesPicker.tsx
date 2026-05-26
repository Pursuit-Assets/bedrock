import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, Paperclip, Upload } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  fileDownloadUrl,
  useOpportunityFiles,
  useUploadOpportunityFile,
} from "@/services/files";

/**
 * Files picker for stage-gate dialogs. Shows every file currently
 * attached to the opp + a drop zone / file input for new uploads.
 * Selecting an existing file or completing an upload marks the gate
 * "satisfied" via onSatisfiedChange — the dialog's primary button
 * stays disabled until that fires.
 *
 * Filter prop narrows the displayed list by filename substring
 * ("proposal", "contract", etc.) — purely cosmetic; the gate logic
 * accepts ANY attached file as proof.
 */
export function OpportunityFilesPicker({
  opportunityId,
  label,
  filenameHint,
  onSatisfiedChange,
}: {
  opportunityId: string;
  /** Header line, e.g. "Proposal" / "Contract". */
  label: string;
  /** Filename keyword to nudge the user toward the right file (e.g.
   *  "proposal"). Filter chips above the list let the user toggle. */
  filenameHint?: string;
  /** Called whenever the satisfied state changes (file found OR
   *  successful upload OR the user explicitly confirms). */
  onSatisfiedChange?: (satisfied: boolean) => void;
}) {
  const filesQ = useOpportunityFiles(opportunityId);
  const upload = useUploadOpportunityFile(opportunityId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [filterToHint, setFilterToHint] = useState(Boolean(filenameHint));

  const allFiles = filesQ.data ?? [];
  const filtered = filterToHint && filenameHint
    ? allFiles.filter((f) =>
        (f.title ?? "").toLowerCase().includes(filenameHint.toLowerCase()),
      )
    : allFiles;

  // Gate is satisfied as long as ≥1 file exists matching the filter
  // (or any file if no filter is active). Surface to parent via
  // useEffect so we never call setState-style callbacks during render.
  const satisfied = filtered.length > 0;
  useEffect(() => {
    onSatisfiedChange?.(satisfied);
  }, [satisfied, onSatisfiedChange]);

  const handlePick = () => fileInputRef.current?.click();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setPendingName(file.name);
    try {
      await upload.mutateAsync({ file });
    } finally {
      setPendingName(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          {label}
        </span>
        <div className="flex items-center gap-2">
          {filenameHint ? (
            <button
              type="button"
              onClick={() => setFilterToHint((v) => !v)}
              className={cn(
                "text-[11px] underline-offset-2 hover:underline",
                filterToHint ? "text-accent-ink" : "text-ink-3",
              )}
              title={
                filterToHint
                  ? `Showing files matching "${filenameHint}"`
                  : "Showing all files on this opportunity"
              }
            >
              {filterToHint ? `filter: ${filenameHint}` : "show all"}
            </button>
          ) : null}
          {satisfied ? (
            <Tag variant="green">
              <CheckCircle2 size={11} /> attached
            </Tag>
          ) : (
            <Tag variant="amber">missing</Tag>
          )}
        </div>
      </div>

      {/* File list */}
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        {filesQ.isLoading ? (
          <div className="px-3 py-3 text-center text-[12px] text-ink-3">
            <Loader2 size={12} className="mr-1 inline animate-spin" /> Loading files…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-3 text-center text-[12px] italic text-ink-3">
            {allFiles.length === 0
              ? "No files attached yet — upload one below."
              : `No files matching "${filenameHint}". Upload one or toggle the filter off.`}
          </div>
        ) : (
          <ul className="divide-y divide-border-strong">
            {filtered.map((f) => (
              <li key={f.content_document_id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                <FileText size={13} className="flex-shrink-0 text-ink-3" />
                <a
                  href={fileDownloadUrl(f.latest_version_id) ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-medium text-ink hover:underline"
                  title={f.title ?? ""}
                >
                  {f.title ?? "(no title)"}{f.extension ? `.${f.extension}` : ""}
                </a>
                <span className="text-[10.5px] text-ink-4">{fmtDate(f.created_date)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Upload row */}
      <div className="flex items-center justify-between gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={handlePick}
          disabled={upload.isPending}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          {upload.isPending ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Uploading {pendingName ?? "…"}
            </>
          ) : (
            <>
              <Upload size={12} /> Upload file
            </>
          )}
        </button>
        {upload.isError ? (
          <span className="text-[11px] text-red">Upload failed — try again</span>
        ) : null}
      </div>
    </div>
  );
}

export { Paperclip };
