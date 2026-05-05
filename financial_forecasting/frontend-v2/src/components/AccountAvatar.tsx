import { useEffect, useState } from "react";

import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Extract a bare hostname from anything that might contain one — a stored
 * `logo.clearbit.com/{domain}` URL, a raw domain like `nytimes.com`, or
 * a full Website URL like `https://www.example.org/path?x=1`. Returns
 * null if no plausible host can be parsed.
 */
function extractDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Stored Clearbit URLs encode the domain as the path segment.
  const cb = /^https?:\/\/logo\.clearbit\.com\/([^?#/]+)/i.exec(trimmed);
  if (cb) return cb[1].toLowerCase();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return host.includes(".") ? host : null;
}

/**
 * icon.horse prefers apple-touch-icon (typically 180×180 PNG on modern
 * sites) and falls back to favicon. Returns 404 for missing domains so
 * `<img onError>` still triggers our initials fallback. Free, no auth,
 * higher quality than Google S2 — which is capped by whatever favicon
 * the site exposes (often 16/32px) and renders blurry when upscaled.
 *
 * To upgrade beyond favicons/touch-icons to real brand logos, swap
 * this function to logo.dev (`img.logo.dev/{domain}?token=...&size=N`)
 * or Brandfetch. Both require a token but emit proper logo marks at
 * any size. DB and component shape stay unchanged.
 */
function iconUrl(domain: string): string {
  return `https://icon.horse/icon/${encodeURIComponent(domain)}`;
}

/**
 * Avatar tile for an SF Account. Renders the company logo when one
 * exists in `public.companies` (via bedrock.sf_account_company_map),
 * falls back to a colored initials gradient otherwise. Same layout in
 * both states so list rows stay aligned.
 *
 * Image errors (404, broken Clearbit link, CORS) silently fall back to
 * initials — never shows a broken-image icon.
 */
export function AccountAvatar({
  name,
  logoUrl,
  website,
  size = 24,
  className,
}: {
  name: string | null | undefined;
  logoUrl: string | null | undefined;
  /** SF Account.Website fallback when no public.companies match exists. */
  website?: string | null | undefined;
  size?: number;
  className?: string;
}) {
  // Resolution chain (each step falls through on <img> error):
  //   1. `logoUrl` is a direct image URL (Apollo, etc.) — use as-is
  //   2. icon.horse from extracted domain (Clearbit pointer or SF Website)
  //   3. Initials fallback
  const isClearbitPointer =
    !!logoUrl && /^https?:\/\/logo\.clearbit\.com\//i.test(logoUrl);
  const directLogo = !!logoUrl && !isClearbitPointer ? logoUrl : null;
  const fallbackDomain =
    (isClearbitPointer ? extractDomain(logoUrl!) : null) ??
    extractDomain(website ?? "");
  const fallbackUrl = fallbackDomain ? iconUrl(fallbackDomain) : null;

  // `step` advances on each <img> error: 0 = direct, 1 = icon.horse, 2 = initials.
  const [step, setStep] = useState(0);
  const candidates = [directLogo, fallbackUrl].filter(Boolean) as string[];

  // Virtual-list recycling: the same AccountAvatar instance gets reused
  // for different rows as the user scrolls. If row A errored and bumped
  // step → 2, and React reuses the instance for row B (different
  // logoUrl), step stays at 2 and B falsely shows initials. Reset
  // whenever the candidate URLs change.
  const candidatesKey = candidates.join("|");
  useEffect(() => {
    setStep(0);
  }, [candidatesKey]);

  const resolved = candidates[step] ?? null;
  const showLogo = !!resolved;

  return (
    <div
      className={cn(
        "grid flex-shrink-0 place-items-center overflow-hidden rounded-md font-semibold text-surface",
        className,
      )}
      style={{
        width: size,
        height: size,
        // Subtle ring so a white logo on white background still has a boundary
        background: showLogo
          ? "var(--surface-2, #f4f4f5)"
          : "linear-gradient(135deg, oklch(0.65 0.10 250), oklch(0.50 0.13 270))",
        fontSize: Math.max(9, Math.round(size / 3)),
      }}
      title={name ?? ""}
    >
      {showLogo ? (
        <img
          /* Force a re-mount when the candidate URL changes so the
             browser re-evaluates `onError` against the new src. */
          key={resolved}
          src={resolved}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setStep((s) => s + 1)}
          /* Render at natural size up to the tile, never upscaled —
             a small favicon stays crisp at 32px on a 48px tile rather
             than being stretched into pixel mush. */
          style={{ maxWidth: "85%", maxHeight: "85%", width: "auto", height: "auto" }}
          className="object-contain"
        />
      ) : (
        <span>{initials(name ?? "?")}</span>
      )}
    </div>
  );
}
