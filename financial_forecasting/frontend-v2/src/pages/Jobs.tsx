/**
 * Jobs page — multi-source employer / placement view.
 *
 * Three stacked sections, each from a different data source:
 *   1. Accounts with PBC wins or Fellow affiliations (Salesforce)
 *   2. Builder data (Airtable — Companies / Jobs / Engagements / Job Deals)
 *   3. Sputnik leads (segundo-db public.contacts)
 *
 * Sections 2+3 are tagged "Pre-merge" — they aren't yet reconciled
 * against Salesforce records. Entity resolution / merge is out of scope
 * for this first cut.
 */
import { PageHeader } from "@/components/PageHeader";

import { JobsAccounts } from "./jobs/JobsAccounts";
import { JobsAirtable } from "./jobs/JobsAirtable";
import { JobsSputnik } from "./jobs/JobsSputnik";

export function JobsPage() {
  return (
    <div className="flex flex-col gap-5 px-7 py-6 pb-12">
      <PageHeader
        title="Jobs"
        subtitle="Employer placements, builder pipeline, and platform leads — across Salesforce, Airtable, and Sputnik."
      />

      <JobsAccounts />
      <JobsAirtable />
      <JobsSputnik />
    </div>
  );
}
