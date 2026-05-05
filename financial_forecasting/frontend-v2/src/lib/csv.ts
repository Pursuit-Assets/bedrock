/**
 * CSV export utilities — RFC 4180 quoting + UTF-8 BOM so Excel
 * renders accented characters correctly on first open.
 *
 * Used by the Cleanup tabs' Export buttons; can be reused anywhere
 * else we need to surface a filtered grid as a downloadable file.
 */

export interface CsvColumn<T> {
  /** Header cell label. */
  label: string;
  /** Extract the cell value from a row. Returning `null` / `undefined`
   *  produces an empty cell. Numbers / strings serialize directly. */
  getValue: (row: T) => unknown;
}

/**
 * RFC 4180 quoting: wrap in double-quotes if the cell contains a
 * comma, double-quote, or line break; double-up internal quotes.
 */
export function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  const needsQuotes =
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r");
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeCsvCell(c.label)).join(",");
  const body = rows.map((r) =>
    columns.map((c) => escapeCsvCell(c.getValue(r))).join(","),
  );
  // CRLF terminator is the standards-compliant choice and keeps Windows
  // Excel happy. Trailing newline avoids "missing newline at end" gripes
  // from downstream tools.
  return [header, ...body, ""].join("\r\n");
}

/**
 * Trigger a browser download for `csv`. Prepends a UTF-8 BOM so Excel
 * (which sniffs encoding from the BOM, not the Content-Type header)
 * doesn't mojibake non-ASCII names like "Café Société". Frees the
 * blob URL after the download starts.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the click handler has time to start the download
  // (Safari is finicky if you revoke synchronously).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Convenience wrapper — auto-suffixes today's date so consecutive
 * exports don't overwrite each other in the user's Downloads folder.
 *
 *   exportRowsAsCsv("cleanup-accounts", rows, columns)
 *   → cleanup-accounts-2026-05-04.csv
 */
export function exportRowsAsCsv<T>(
  baseFilename: string,
  rows: T[],
  columns: CsvColumn<T>[],
): void {
  const date = new Date().toISOString().slice(0, 10);
  downloadCsv(`${baseFilename}-${date}.csv`, rowsToCsv(rows, columns));
}
