// Top-of-funnel triage: scope rows to accounts/contacts touched within a recent
// window (or gone quiet). Matched against last_activity_at (jobs-team activity
// recency). Shared by the Accounts hub and the Contacts view so both read the same.

export const ACTIVITY_WINDOWS: { value: string; label: string; days: number | null }[] = [
  { value: "all",  label: "Any activity",      days: null },
  { value: "7",    label: "Active past week",  days: 7 },
  { value: "30",   label: "Active past month", days: 30 },
  { value: "90",   label: "Active past 90d",   days: 90 },
  { value: "none", label: "No recent activity", days: 0 },
];

/** Does this row's last_activity_at fall inside the selected window? */
export function inActivityWindow(
  last_activity_at: string | null | undefined,
  win: string,
): boolean {
  if (win === "all") return true;
  const last = last_activity_at ? new Date(last_activity_at).getTime() : null;
  const daysAgo = last == null ? Infinity : (Date.now() - last) / 86_400_000;
  if (win === "none") return daysAgo > 90; // quiet for 90+ days
  const w = ACTIVITY_WINDOWS.find((o) => o.value === win);
  return w?.days != null && daysAgo <= w.days;
}
