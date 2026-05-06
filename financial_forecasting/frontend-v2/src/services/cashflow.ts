import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface CashflowMonth {
  month: number; // 1–12
  actuals: number;
  scheduled: number;
  projected: number;
}

export type CashflowType = "actuals" | "scheduled" | "outstanding" | "projected";

export interface CashflowDetailRecord {
  payment_id: string | null;
  opp_id: string | null;
  amount: number;
  weighted_amount: number | null;
  probability: number | null;
  date: string | null;
  opp_name: string | null;
  account_name: string | null;
  stage: string | null;
}

export function useCashflowDetail(
  year: number,
  month: number | null,
  type: CashflowType | null,
) {
  return useQuery({
    queryKey: ["cashflow-detail", year, month, type],
    queryFn: async () => {
      const { data } = await api.get<CashflowDetailRecord[]>(
        `/api/salesforce/cashflow/detail?year=${year}&month=${month}&type=${type}`,
      );
      return data;
    },
    enabled: month !== null && type !== null,
    staleTime: 5 * 60_000,
  });
}

export function useCashflow(year: number) {
  return useQuery({
    queryKey: ["cashflow", year],
    queryFn: async () => {
      const { data } = await api.get<CashflowMonth[]>(
        `/api/salesforce/cashflow?year=${year}`,
      );
      return data;
    },
    staleTime: 5 * 60_000,
  });
}
