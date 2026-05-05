import { useMemo } from "react";

import { Tag } from "@/components/ui/Tag";
import {
  useAppUsers,
  useUpdateAppUser,
  usePermissionProfiles,
} from "@/services/admin";

export function UsersTab() {
  const usersQ = useAppUsers();
  const profilesQ = usePermissionProfiles();
  const update = useUpdateAppUser();

  const profileOptions = useMemo(
    () =>
      (profilesQ.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [profilesQ.data],
  );

  const profileNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profilesQ.data ?? []) m.set(p.id, p.name);
    return m;
  }, [profilesQ.data]);

  const rows = (usersQ.data ?? [])
    .slice()
    .sort((a, b) => {
      // Active first, then alphabetical.
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return (a.name ?? a.email).localeCompare(b.name ?? b.email);
    });

  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="border-b border-border-strong bg-surface-2 px-5 py-2.5">
        <div className="text-[13px] font-semibold text-ink">Users</div>
        <div className="mt-0.5 text-[12px] text-ink-3">
          Bedrock identity · permission profile · active in app
        </div>
      </div>

      {usersQ.isLoading ? (
        <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
          Loading users…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
          No users provisioned yet.
        </div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-4 py-1.5 text-left font-semibold">Name</th>
              <th className="px-4 py-1.5 text-left font-semibold">Email</th>
              <th className="px-4 py-1.5 text-left font-semibold">Profile</th>
              <th className="px-4 py-1.5 text-left font-semibold">Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-border-strong">
                <td className="px-4 py-2 font-medium">
                  {u.name ?? <span className="text-ink-4">—</span>}
                </td>
                <td className="px-4 py-2 text-ink-2">{u.email}</td>
                <td className="px-4 py-2">
                  <select
                    value={u.profile_id ?? ""}
                    onChange={(e) =>
                      update.mutate({
                        id: u.id,
                        patch: { profile_id: e.target.value },
                      })
                    }
                    className="h-7 min-w-[160px] rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
                  >
                    <option value="" disabled>
                      {u.profile_id
                        ? (profileNameById.get(u.profile_id) ?? "Unknown")
                        : "Choose profile…"}
                    </option>
                    {profileOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      update.mutate({
                        id: u.id,
                        patch: { is_active: !u.is_active },
                      })
                    }
                    className="inline-flex items-center"
                    title={u.is_active ? "Deactivate" : "Activate"}
                  >
                    {u.is_active ? (
                      <Tag variant="green">Active</Tag>
                    ) : (
                      <Tag>Inactive</Tag>
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
