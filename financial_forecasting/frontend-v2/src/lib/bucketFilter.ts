/**
 * Client-side record-type bucket filter for opportunities.
 * Same buckets as the cashflow backend (`_cashflow_bucket_soql`).
 */
import type { SfOpportunity } from "@/types/salesforce";
import type { CashflowBucket } from "@/services/cashflow";

export function filterByBucket(
  opps: SfOpportunity[],
  bucket: CashflowBucket,
): SfOpportunity[] {
  if (bucket === "all") return opps;
  return opps.filter((o) => oppMatchesBucket(o, bucket));
}

export function oppMatchesBucket(
  o: SfOpportunity,
  bucket: CashflowBucket,
): boolean {
  const rt = o.RecordType?.Name ?? "";
  const pt = o.Philanthropy_Type__c ?? "";
  switch (bucket) {
    case "philanthropy":
      return rt === "Philanthropy" && pt !== "Capital Grant";
    case "capital_grants":
      return pt === "Capital Grant";
    case "pbc":
      return rt === "PBC";
    case "other":
      return rt !== "Philanthropy" && rt !== "PBC" && pt !== "Capital Grant";
    default:
      return true;
  }
}
