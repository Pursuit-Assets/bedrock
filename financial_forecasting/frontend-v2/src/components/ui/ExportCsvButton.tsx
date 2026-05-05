/**
 * Toolbar button that exports an arbitrary array of rows as CSV.
 * Disabled with a friendly tooltip when there's nothing to export.
 */
import { Download } from "lucide-react";

import { type CsvColumn, exportRowsAsCsv } from "@/lib/csv";

export interface ExportCsvButtonProps<T> {
  /** Filename without extension or date suffix.
   *  Example: "cleanup-accounts" → "cleanup-accounts-2026-05-04.csv". */
  baseFilename: string;
  rows: T[];
  columns: CsvColumn<T>[];
}

export function ExportCsvButton<T>({
  baseFilename,
  rows,
  columns,
}: ExportCsvButtonProps<T>) {
  const empty = rows.length === 0;
  return (
    <button
      type="button"
      onClick={() => {
        if (empty) return;
        exportRowsAsCsv(baseFilename, rows, columns);
      }}
      disabled={empty}
      title={
        empty
          ? "Nothing to export — adjust filters first"
          : `Export ${rows.length.toLocaleString()} rows as CSV`
      }
      className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download size={12} aria-hidden="true" />
      Export {rows.length > 0 ? rows.length.toLocaleString() : ""}
    </button>
  );
}
