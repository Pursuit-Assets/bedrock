import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Avatar for a Salesforce Contact. Renders the SF `Contact.PhotoUrl` when
 * present; falls back to initials in a deterministic-color circle so the
 * same person always gets the same background hue across renders.
 *
 * Mirrors the resting/fallback behavior of `AccountAvatar` but is keyed on
 * a person's name rather than a company name.
 */
export function FellowAvatar({
  name,
  photoUrl,
  size = 28,
}: {
  name: string | null | undefined;
  photoUrl: string | null | undefined;
  size?: number;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const initials = toInitials(name);

  if (photoUrl && !imgFailed) {
    return (
      <img
        src={photoUrl}
        alt={name ?? ""}
        onError={() => setImgFailed(true)}
        style={{ width: size, height: size }}
        className="flex-shrink-0 rounded-full border border-border-strong object-cover"
      />
    );
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        backgroundColor: hueFor(name ?? ""),
        fontSize: Math.max(10, Math.round(size * 0.4)),
      }}
      className={cn(
        "flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white",
      )}
      aria-label={name ?? "Fellow"}
    >
      {initials}
    </div>
  );
}

function toInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Small palette of friendly muted hues — deterministically picked from name
// so the same person doesn't get a different color on each render.
const PALETTE = [
  "#5B6CFF", "#8E5BFF", "#D45BFF", "#FF5B9B", "#FF8E5B",
  "#FFC15B", "#5BFFA1", "#5BD4FF", "#5B9BFF",
];

function hueFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
