import type { AccountStatus } from "@/types/salesforce";

/**
 * Playbook Account Status → Tag color variant.
 *
 *   Prospect       default (neutral)
 *   Pursuing       accent  (purple — active hunt)
 *   Stewarding     green   (healthy delivery in flight)
 *   Re-activating  amber   (recent touch, but no open opp / award)
 *   Dormant        red     (needs renewed effort)
 *
 * Kept in /lib so every page that renders an accounts table picks
 * up the same colors without duplicating the switch.
 */
export function accountStatusVariant(
  s: AccountStatus,
): "default" | "accent" | "green" | "amber" | "red" {
  switch (s) {
    case "Pursuing": return "accent";
    case "Stewarding": return "green";
    case "Re-activating": return "amber";
    case "Dormant": return "red";
    default: return "default";
  }
}
