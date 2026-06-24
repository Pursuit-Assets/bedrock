// Dropdown windows for the "Last activity" recency filter (a FieldType:"recency"
// field in the AddFilter mechanism). Value is a days string, or "none" for quiet.
// Shared by the Accounts hub and Contacts view so both read the same.

export const RECENCY_OPTIONS: { value: string; label: string }[] = [
  { value: "7",    label: "Last 7 days" },
  { value: "30",   label: "Last 30 days" },
  { value: "90",   label: "Last 90 days" },
  { value: "none", label: "No activity in 90+ days" },
];

export function recencyLabel(value: string): string {
  return RECENCY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
