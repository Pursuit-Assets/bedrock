import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface SfPayment {
  Id: string;
  npe01__Payment_Amount__c: number | null;
  npe01__Scheduled_Date__c: string | null;
  npe01__Payment_Date__c: string | null;
  npe01__Paid__c: boolean;
  npe01__Written_Off__c?: boolean;
  npe01__Payment_Method__c?: string | null;
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

export function useACVSummary(year: number) {
  return useQuery({
    queryKey: ["acv-summary", year],
    queryFn: async () => {
      const { data } = await api.get<ACVSummary>(
        `/api/salesforce/payments/acv-summary?year=${year}`,
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
