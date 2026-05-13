import { useParams, Navigate } from "react-router-dom";

import { OWNER_HOME_BY_SLUG, OWNER_HOMES } from "./slugs";

/** Route entry for `/home/:slug`. Picks the right Home<Name> component
 *  by slug; falls back to /dashboard for unknown slugs so a typo can't
 *  trap the user on a blank page. */
export function HomePage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const entry = OWNER_HOME_BY_SLUG[slug.toLowerCase()];
  if (!entry) return <Navigate to="/dashboard" replace />;
  const Component = entry.component;
  return <Component />;
}

/** Tiny index page at `/home` listing everyone's home — useful while
 *  the per-owner pages are being built so each person can preview the
 *  others. Will be replaced once the per-user default-home rule lands. */
export function HomeIndexPage() {
  return (
    <div className="mx-auto max-w-[800px] px-7 py-10">
      <h1 className="text-[24px] font-semibold text-ink">Owner homes</h1>
      <p className="mt-2 text-[13px] text-ink-3">
        Pick whose home to view. Each owner is iterating on their own page
        in their own branch.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {OWNER_HOMES.map((h) => (
          <li key={h.slug}>
            <a
              href={`/home/${h.slug}`}
              className="block rounded-lg border border-border-strong bg-surface px-4 py-3 text-[14px] font-medium text-ink hover:border-accent hover:bg-surface-2"
            >
              {h.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
