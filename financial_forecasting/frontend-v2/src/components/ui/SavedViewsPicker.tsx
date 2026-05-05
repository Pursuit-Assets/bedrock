/**
 * Saved Views picker — toolbar dropdown for loading / saving filter
 * views, server-backed via `/api/saved-views`.
 *
 * Visibility:
 *   - Personal views (owner = caller) appear in the "Your views"
 *     section. The user can rename / delete their own.
 *   - Global views (admin-curated, shared org-wide) appear under
 *     "Shared" with a small badge. Admins can edit them; everyone
 *     else gets click-to-load only.
 *
 * `scopeKey` namespaces the view to a list page so a name like
 * "Open Q4" can exist independently across pages.
 *
 * `currentFilters` is the live filter shape this page would persist
 * if the user clicks "Save current view." The shape is opaque — the
 * picker treats it as JSON.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, Globe, Lock, Trash2, User } from "lucide-react";

import { cn } from "@/lib/utils";
import { usePerm } from "@/services/permissions";
import {
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  type SavedView,
} from "@/services/savedViews";

interface SavedViewsPickerProps<F> {
  /** Stable identifier for the list page — e.g. "pipeline". */
  scopeKey: string;
  /** Current filter shape, persisted as the new view's payload on save. */
  currentFilters: F;
  /** Called with the deserialized payload when the user picks a view. */
  onLoad: (filters: F) => void;
  /**
   * Backwards-compat: previous signature used `storageKey` (localStorage).
   * Kept for existing call sites that haven't migrated yet — we ignore
   * it in favor of `scopeKey`. Drop once all call sites are switched.
   */
  storageKey?: string;
}

export function SavedViewsPicker<F>({
  scopeKey,
  currentFilters,
  onLoad,
}: SavedViewsPickerProps<F>) {
  const isAdmin = usePerm("manage_users_roles");

  const viewsQ = useSavedViews<F>(scopeKey);
  const create = useCreateSavedView<F>(scopeKey);
  const del = useDeleteSavedView(scopeKey);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [saveGlobal, setSaveGlobal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setSaving(false);
        setError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const views = viewsQ.data ?? [];
  const { personal, global } = useMemo(() => {
    const p: SavedView<F>[] = [];
    const g: SavedView<F>[] = [];
    for (const v of views) (v.is_global ? g : p).push(v);
    return { personal: p, global: g };
  }, [views]);

  const saveView = async () => {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      await create.mutateAsync({
        scope_key: scopeKey,
        name,
        filters: currentFilters,
        is_global: saveGlobal && isAdmin,
      });
      setNewName("");
      setSaveGlobal(false);
      setSaving(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  const deleteView = async (id: string) => {
    try {
      await del.mutateAsync(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const totalCount = views.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink",
          open && "bg-surface-2 text-ink",
        )}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Bookmark
          size={12}
          className={cn(totalCount > 0 && "fill-current opacity-60")}
          aria-hidden="true"
        />
        Views {totalCount > 0 ? `(${totalCount})` : ""}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-8 z-30 min-w-[260px] max-w-[360px] rounded-lg border border-border-strong bg-surface p-1.5 shadow-lg"
          role="menu"
        >
          {/* Shared / global views */}
          {global.length > 0 ? (
            <>
              <SectionLabel
                icon={<Globe size={10} aria-hidden="true" />}
                text="Shared"
              />
              {global.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  canDelete={isAdmin}
                  onLoad={() => {
                    onLoad(v.filters);
                    setOpen(false);
                  }}
                  onDelete={() => void deleteView(v.id)}
                />
              ))}
            </>
          ) : null}

          {/* Personal */}
          {personal.length > 0 ? (
            <>
              {global.length > 0 ? (
                <div className="my-1 border-t border-border-strong" />
              ) : null}
              <SectionLabel
                icon={<User size={10} aria-hidden="true" />}
                text="Your views"
              />
              {personal.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  canDelete={true}
                  onLoad={() => {
                    onLoad(v.filters);
                    setOpen(false);
                  }}
                  onDelete={() => void deleteView(v.id)}
                />
              ))}
            </>
          ) : null}

          {totalCount > 0 ? (
            <div className="my-1 border-t border-border-strong" />
          ) : null}

          {saving ? (
            <div className="px-1 py-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveView();
                  if (e.key === "Escape") {
                    setSaving(false);
                    setNewName("");
                    setSaveGlobal(false);
                    setError(null);
                  }
                }}
                placeholder="View name…"
                className="w-full rounded border border-border-strong px-2 py-1 text-[12px] outline-none focus:border-accent"
              />
              {isAdmin ? (
                <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 px-1 text-[11.5px] text-ink-3">
                  <input
                    type="checkbox"
                    checked={saveGlobal}
                    onChange={(e) => setSaveGlobal(e.target.checked)}
                    className="h-3 w-3 accent-accent"
                  />
                  <Globe size={10} aria-hidden="true" />
                  Share with everyone (global view)
                </label>
              ) : null}
              {error ? (
                <div className="mt-1 rounded bg-red/5 px-2 py-0.5 text-[11px] text-red">
                  {error}
                </div>
              ) : null}
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                  onClick={() => {
                    setSaving(false);
                    setNewName("");
                    setSaveGlobal(false);
                    setError(null);
                  }}
                  className="rounded px-2 py-0.5 text-[11.5px] text-ink-3 hover:text-ink-2"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void saveView()}
                  disabled={!newName.trim() || create.isPending}
                  className="rounded bg-ink px-2 py-0.5 text-[11.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setSaving(true)}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <BookmarkPlus size={12} aria-hidden="true" />
              Save current view
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
      {icon}
      {text}
    </div>
  );
}

function ViewRow<F>({
  view,
  canDelete,
  onLoad,
  onDelete,
}: {
  view: SavedView<F>;
  canDelete: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group flex items-center gap-1 rounded px-2 py-1.5 hover:bg-surface-2"
      role="menuitem"
    >
      <button
        className="min-w-0 flex-1 truncate text-left text-[12.5px] text-ink"
        onClick={onLoad}
        title={view.name}
      >
        {view.name}
      </button>
      {!canDelete ? (
        <Lock
          size={10}
          className="text-ink-4"
          aria-label="You can't edit this shared view"
        />
      ) : (
        <button
          className="hidden text-ink-3 hover:text-red group-hover:block"
          onClick={onDelete}
          aria-label={`Delete "${view.name}"`}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}
