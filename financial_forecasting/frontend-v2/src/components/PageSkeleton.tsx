/**
 * Suspense fallback for lazy-loaded routes.
 *
 * Intentionally minimal — a soft pulse on a content-sized surface so the
 * user perceives the route "starting" without a layout shift when the
 * real page mounts. Sized to span the AppShell content area.
 */
export function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-6" aria-busy="true">
      <div className="mb-6 h-7 w-48 animate-pulse rounded bg-surface-2" />
      <div className="space-y-2">
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="h-28 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-28 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-28 animate-pulse rounded-lg bg-surface-2" />
      </div>
      <div className="mt-6 h-72 animate-pulse rounded-lg bg-surface-2" />
    </div>
  );
}
