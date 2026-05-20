import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Mirrors a row in `public.outreach` (staff personal-outreach tracker). */
export interface SputnikLead {
  id: number;
  staff_user_id: number | null;
  staff_name: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  contact_method: string | null;
  outreach_date: string | null;
  status: string | null;
  stage: string | null;
  stage_detail: string | null;
  ownership: string | null;
  current_owner: string | null;
  source: string | string[] | null;
  aligned_sector: string | string[] | null;
  job_title: string | null;
  notes: string | null;
  response_notes: string | null;
  last_interaction_date: string | null;
  last_interaction_type: string | null;
  created_at: string | null;
  updated_at: string | null;
  // Schema-tolerant fallback may include extras.
  [key: string]: unknown;
}

export interface SputnikResponse {
  data: SputnikLead[];
  available: boolean;
  error?: string;
}

export function useSputnikLeads() {
  return useQuery({
    queryKey: ["sputnik-leads"],
    queryFn: async () => {
      const { data } = await api.get<SputnikResponse>("/api/sputnik/leads");
      return data;
    },
    staleTime: 5 * 60_000,
  });
}
