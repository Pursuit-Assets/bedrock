import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SfPayment {
  Id: string;
  Name?: string | null;
  npe01__Opportunity__c?: string | null;
  npe01__Payment_Amount__c: number | null;
  npe01__Scheduled_Date__c: string | null;
  npe01__Payment_Date__c: string | null;
  npe01__Paid__c: boolean;
  npe01__Written_Off__c?: boolean;
  npe01__Payment_Method__c?: string | null;
  npe01__Check_Reference_Number__c?: string | null;
  Write_off_reason__c?: string | null;
  Amount_Received__c?: number | null;
  Amount_Minus_Received__c?: number | null;
  Amount_Formula__c?: number | null;
  Payment_Status__c?: string | null;
  Paid_Status__c?: string | null;
  Delinquent__c?: boolean | null;
  Department__c?: string | null;
  GL_Account__c?: string | null;
  GL_Payment_Received__c?: string | null;
  Reconciled_with_Finance__c?: boolean | null;
  Batch_Name__c?: string | null;
  Payment_Estimate__c?: boolean | null;
  Affiliation__c?: string | null;
  CreatedDate?: string | null;
  LastModifiedDate?: string | null;
  npe01__Opportunity__r?: {
    Name?: string;
    Account?: { Name?: string };
  };
}

async function fetchPayments(): Promise<SfPayment[]> {
  const { data } = await api.get<SfPayment[]>("/api/salesforce/payments?limit=2000");
  return data;
}

export function usePayments() {
  return useQuery({
    queryKey: ["payments"],
    queryFn: fetchPayments,
    staleTime: 60_000,
  });
}

export function useOpportunityPayments(opportunityId: string | null) {
  return useQuery({
    queryKey: ["opp-payments", opportunityId],
    queryFn: async () => {
      const { data } = await api.get<SfPayment[]>(
        `/api/salesforce/opportunities/${opportunityId}/payments`,
      );
      return data;
    },
    enabled: !!opportunityId,
    staleTime: 60_000,
  });
}

export interface PaymentPatch {
  npe01__Payment_Amount__c?: number;
  npe01__Scheduled_Date__c?: string | null;
  npe01__Payment_Date__c?: string | null;
  npe01__Paid__c?: boolean;
  npe01__Payment_Method__c?: string | null;
  npe01__Written_Off__c?: boolean;
  npe01__Check_Reference_Number__c?: string | null;
  Write_off_reason__c?: string | null;
  Department__c?: string | null;
  GL_Account__c?: string | null;
  GL_Payment_Received__c?: string | null;
  Reconciled_with_Finance__c?: boolean;
  Batch_Name__c?: string | null;
  Payment_Estimate__c?: boolean;
}

export function useUpdatePayment(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PaymentPatch }) => {
      const { data } = await api.put(`/api/salesforce/payments/${id}`, { updates: patch });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

/** Same write path as useUpdatePayment, but scoped to the global
 *  /payments page (no parent opp context). Invalidates the
 *  ["payments"] query so the table refreshes. */
export function useUpdateAnyPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PaymentPatch }) => {
      const { data } = await api.put(`/api/salesforce/payments/${id}`, { updates: patch });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["opp-payments"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}

export interface PaymentScheduleItem {
  amount: number;
  scheduled_date: string; // YYYY-MM-DD
}

/**
 * Create a payment schedule by replacing (or appending to) the existing
 * SF payments. Backend rejects if `sum(amounts) !== Opportunity.Amount`,
 * so callers should validate the total before submitting.
 */
interface ACVSummary {
  fy: number;
  q1: number;
  q2: number;
  q3: number;
  q4: number;
}

export function useACVSummary(year: number, bucket: string = "all") {
  return useQuery({
    queryKey: ["acv-summary", year, bucket],
    queryFn: async () => {
      const { data } = await api.get<ACVSummary>(
        `/api/salesforce/payments/acv-summary?year=${year}&bucket=${bucket}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useCreatePaymentSchedule(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      payments: PaymentScheduleItem[];
      delete_existing?: boolean;
    }) => {
      const { data } = await api.post<{ success: boolean; payments_created: number }>(
        "/api/opportunities/create-payment-schedule",
        {
          opportunity_id: opportunityId,
          payments: input.payments,
          delete_existing: input.delete_existing ?? true,
        },
      );
      return data;
    },
    onSuccess: () => {
      // Invalidate both query keys — the expand panels use "opp-payments"
      // while OpportunityDetail uses "opportunity-payments".
      qc.invalidateQueries({ queryKey: ["opp-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunity-payments", opportunityId] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["awards"] });
    },
  });
}
