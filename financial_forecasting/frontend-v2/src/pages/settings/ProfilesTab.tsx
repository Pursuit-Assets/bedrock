import { useMemo, useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import {
  PERMISSION_GROUPS,
  SYSTEM_PERMISSION_KEYS,
  useCreatePermissionProfile,
  useDeletePermissionProfile,
  usePermissionProfiles,
  useUpdatePermissionProfile,
  type PermissionProfile,
} from "@/services/admin";

export function ProfilesTab({
  isAdmin,
  canEdit,
}: {
  isAdmin: boolean;
  canEdit: boolean;
}) {
  const profilesQ = usePermissionProfiles();
  const createProfile = useCreatePermissionProfile();
  const updateProfile = useUpdatePermissionProfile();
  const deleteProfile = useDeletePermissionProfile();

  const profiles = profilesQ.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select the first profile once loaded.
  const effectiveSelectedId = useMemo(() => {
    if (selectedId && profiles.some((p) => p.id === selectedId)) {
      return selectedId;
    }
    return profiles[0]?.id ?? null;
  }, [selectedId, profiles]);

  const selected = profiles.find((p) => p.id === effectiveSelectedId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Profile list */}
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-border-strong bg-surface-2 px-3 py-2">
          <div className="text-[12.5px] font-semibold text-ink">Profiles</div>
          {isAdmin ? (
            <button
              type="button"
              onClick={async () => {
                const name = window.prompt("New profile name");
                if (!name?.trim()) return;
                const created = await createProfile.mutateAsync({
                  name: name.trim(),
                  description: "",
                  is_default: false,
                  permissions: {},
                });
                setSelectedId(created.id);
              }}
              className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink"
              title="New profile"
            >
              <Plus size={13} />
            </button>
          ) : null}
        </div>
        <ul>
          {profiles.length === 0 ? (
            <li className="px-3 py-4 text-center text-[12px] text-ink-3">
              {profilesQ.isLoading ? "Loading…" : "No profiles yet."}
            </li>
          ) : (
            profiles.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-t border-border-strong px-3 py-2 text-left first:border-t-0 hover:bg-surface-2",
                    p.id === effectiveSelectedId && "bg-surface-2",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-ink">
                      {p.name}
                    </div>
                    {p.is_default ? (
                      <Tag variant="green">Default</Tag>
                    ) : null}
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {/* Profile detail. `key={selected.id}` remounts the editor on
          selection change so local form state initializes from the
          new profile's props instead of stale state. */}
      {selected ? (
        <ProfileEditor
          key={selected.id}
          profile={selected}
          isAdmin={isAdmin}
          canEdit={canEdit}
          onSave={async (patch) => {
            await updateProfile.mutateAsync({ id: selected.id, patch });
          }}
          onDelete={async () => {
            if (
              !window.confirm(
                `Delete the "${selected.name}" profile? Users assigned to it must be reassigned first.`,
              )
            ) {
              return;
            }
            try {
              await deleteProfile.mutateAsync(selected.id);
              setSelectedId(null);
            } catch (e) {
              window.alert(
                e instanceof Error ? e.message : "Could not delete profile",
              );
            }
          }}
        />
      ) : (
        <div className="rounded-lg border border-border-strong bg-surface px-5 py-8 text-center text-[12.5px] text-ink-3 shadow-sm">
          Select a profile from the list.
        </div>
      )}
    </div>
  );
}

function ProfileEditor({
  profile,
  isAdmin,
  canEdit,
  onSave,
  onDelete,
}: {
  profile: PermissionProfile;
  isAdmin: boolean;
  canEdit: boolean;
  onSave: (patch: {
    name?: string;
    description?: string;
    is_default?: boolean;
    permissions?: Record<string, boolean>;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? "");
  const [isDefault, setIsDefault] = useState(profile.is_default);
  const [perms, setPerms] = useState<Record<string, boolean>>(
    profile.permissions ?? {},
  );
  const [busy, setBusy] = useState(false);

  const togglePerm = (key: string) => {
    if (!canEdit) return;
    if (SYSTEM_PERMISSION_KEYS.has(key) && !isAdmin) return;
    setPerms((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        name,
        description,
        is_default: isDefault,
        permissions: perms,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="border-b border-border-strong bg-surface-2 px-5 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px] font-semibold text-ink">{profile.name}</div>
          {isAdmin ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="grid h-7 w-7 place-items-center rounded border border-border-strong bg-surface text-ink-3 hover:bg-surface-2 hover:text-red"
              title="Delete profile"
            >
              <Trash2 size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-2">
        <Field label="Name">
          <input
            value={name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent disabled:opacity-60"
          />
        </Field>
        <Field label="Description">
          <input
            value={description}
            disabled={!canEdit}
            onChange={(e) => setDescription(e.target.value)}
            className="h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent disabled:opacity-60"
          />
        </Field>
        <label className="col-span-full flex items-center gap-2 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={isDefault}
            disabled={!isAdmin}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer"
          />
          Default profile for new users
        </label>
      </div>

      <div className="border-t border-border-strong px-5 py-4">
        <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Permissions
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 text-[11.5px] font-semibold text-ink-2">
                {group.label}
              </div>
              <ul className="flex flex-col">
                {group.keys.map(({ key, label }) => {
                  const checked = !!perms[key];
                  const isSystem = SYSTEM_PERMISSION_KEYS.has(key);
                  const locked = !canEdit || (isSystem && !isAdmin);
                  return (
                    <li
                      key={key}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded px-1 py-1 text-[12.5px]",
                        locked && "opacity-60",
                      )}
                    >
                      <label className="flex flex-1 items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => togglePerm(key)}
                          className="h-3.5 w-3.5 cursor-pointer"
                        />
                        <span className="text-ink-2">{label}</span>
                      </label>
                      {isSystem ? (
                        <span
                          title="System permission — admin only"
                          className="text-ink-4"
                        >
                          <Lock size={11} />
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {canEdit ? (
        <div className="flex items-center justify-end gap-2 border-t border-border-strong bg-surface-2 px-5 py-2.5">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="h-8 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </label>
  );
}
