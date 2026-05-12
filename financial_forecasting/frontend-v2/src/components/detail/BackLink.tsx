/**
 * Enterprise back navigation. Uses browser history so the previous
 * page's state (filters, scroll, expanded rows) is fully preserved.
 * Label is always "← Back" — accurate regardless of where the user
 * came from.
 */
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { hasInAppHistory } from "@/lib/navHistory";

export interface BackLinkProps {
  defaultTo: string;
  defaultLabel?: string;
}

export function BackLink({ defaultTo }: BackLinkProps) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate(defaultTo);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink"
    >
      <ArrowLeft size={14} aria-hidden="true" /> Back
    </button>
  );
}
