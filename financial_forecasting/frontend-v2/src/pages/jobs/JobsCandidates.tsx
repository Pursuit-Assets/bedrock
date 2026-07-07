/**
 * Candidates-to-review as its own top-level page (nav: Jobs › Candidates),
 * moved off the Jobs Home screen. Renders the shared CandidatesZone, scoped
 * to the current user by default.
 */
import { useCurrentUser } from "@/services/auth";
import { CandidatesZone } from "./CandidateReview";

export function JobsCandidatesPage() {
  const { data: me } = useCurrentUser();
  return (
    <div className="flex flex-col gap-0 px-7 py-4">
      <h1 className="text-[22px] font-bold text-ink">Candidates to review</h1>
      <p className="mb-3 text-[13px] text-ink-3">
        People surfaced from staff outreach — link to an existing contact/account, promote into the pipeline, or dismiss.
      </p>
      <CandidatesZone key={me?.email ?? "anon"} defaultOwner={me?.email} />
    </div>
  );
}
