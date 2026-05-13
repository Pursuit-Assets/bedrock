/**
 * Devika's home page.
 *
 * Owner: Devika. Edit only this file on the `home/devika` branch.
 *
 * Starting point: this just renders the existing /dashboard page so you
 * have something live to play with. Customize freely:
 *
 *   - Add sections above or below DashboardPage by wrapping it in a div.
 *   - Replace DashboardPage entirely with your own composition.
 *   - Copy pieces out of src/pages/Dashboard.tsx and edit them here
 *     (DashboardPage stays untouched for everyone else).
 *   - Pull data with the hooks in src/services/* — useOpportunities,
 *     useProjects, useAwards, useContacts, useCurrentUser, etc.
 *
 * Ask Claude:
 *   "Add a 'My open opportunities this quarter' table to my home page
 *    using the same data as /pipeline but filtered to ones I own."
 */
import { DashboardPage } from "@/pages/Dashboard";

export function HomeDevika() {
  return <DashboardPage />;
}
