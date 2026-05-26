import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface SfFile {
  content_document_id: string;
  title: string | null;
  extension: string | null;
  size_bytes: number | null;
  latest_version_id: string | null;
  created_date: string | null;
  created_by: string | null;
}

/** SF Lightning Files attached to an Opportunity via ContentDocumentLink. */
export function useOpportunityFiles(opportunityId: string | null | undefined) {
  return useQuery({
    queryKey: ["opportunity-files", opportunityId],
    queryFn: async (): Promise<SfFile[]> => {
      if (!opportunityId) return [];
      const { data } = await api.get<SfFile[]>(
        `/api/salesforce/opportunities/${encodeURIComponent(opportunityId)}/files`,
      );
      return data ?? [];
    },
    enabled: !!opportunityId,
    staleTime: 60_000,
  });
}

interface UploadResult {
  success: boolean;
  data?: {
    content_version_id: string;
    content_document_id: string;
    title: string;
    size_bytes: number;
    filename: string;
  };
}

/**
 * Upload a file to an Opportunity. Wraps the SF Files API
 * (ContentVersion + auto-created ContentDocumentLink) in a single
 * multipart/form-data POST.
 */
export function useUploadOpportunityFile(opportunityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, title }: { file: File; title?: string }) => {
      const fd = new FormData();
      fd.append("file", file);
      if (title) fd.append("title", title);
      // Axios sets the multipart Content-Type (with boundary) when the
      // body is a FormData. We override the instance-level JSON header
      // by handing it FormData directly — no config needed.
      const { data } = await api.post<UploadResult>(
        `/api/salesforce/opportunities/${encodeURIComponent(opportunityId)}/files`,
        fd,
      );
      return data;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["opportunity-files", opportunityId] });
    },
  });
}

/** Convenience: build the SF download URL for a file the user can click. */
export function fileDownloadUrl(latestVersionId: string | null | undefined): string | null {
  if (!latestVersionId) return null;
  // SF synchronous-download path — works for any user with Files
  // access on the parent record. Opens in a new tab in our UI.
  return `https://joinpursuit.lightning.force.com/sfc/servlet.shepherd/version/download/${encodeURIComponent(latestVersionId)}`;
}
