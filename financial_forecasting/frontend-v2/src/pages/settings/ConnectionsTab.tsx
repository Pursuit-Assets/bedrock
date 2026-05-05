import { CheckCircle2, AlertTriangle, Plug, Plug2 } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import {
  startSalesforceConnect,
  useCurrentUser,
  useDisconnectSalesforce,
  useLogout,
  useSalesforceStatus,
} from "@/services/auth";

export function ConnectionsTab({
  banner,
}: {
  banner: { kind: "success" | "error"; text: string } | null;
}) {
  const { data: user } = useCurrentUser();
  const sfStatus = useSalesforceStatus();
  const disconnect = useDisconnectSalesforce();
  const logout = useLogout();

  return (
    <div className="flex flex-col gap-5">
      {banner ? (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]",
            banner.kind === "success"
              ? "border-green bg-green-soft text-green"
              : "border-red bg-red-soft text-red",
          )}
        >
          {banner.kind === "success" ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>{banner.text}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Account" />
        <div className="flex items-center gap-3 px-5 py-4">
          {user?.picture ? (
            <img
              src={user.picture}
              alt=""
              className="h-9 w-9 rounded-full border border-border-strong"
            />
          ) : (
            <div className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-[13px] font-semibold text-ink-2">
              {user?.name?.[0] ?? "?"}
            </div>
          )}
          <div className="flex-1">
            <div className="text-[14px] font-medium">{user?.name ?? "—"}</div>
            <div className="text-[12px] text-ink-3">{user?.email ?? "—"}</div>
          </div>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="h-8 rounded border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Salesforce"
          subtitle="Connect your Salesforce account so changes you make in Bedrock are attributed to you in Salesforce."
        />
        <div className="px-5 py-4">
          {sfStatus.isLoading ? (
            <div className="text-[13px] text-ink-3">
              Checking Salesforce connection…
            </div>
          ) : sfStatus.data?.connected ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Tag variant="green">Connected</Tag>
                <span className="text-[13px] text-ink-2">
                  {sfStatus.data.user_name ?? "Salesforce user"}
                </span>
              </div>
              {sfStatus.data.instance_url ? (
                <div className="text-[12px] text-ink-3">
                  Instance: {sfStatus.data.instance_url}
                </div>
              ) : null}
              <div className="flex gap-2">
                <button
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                  className="inline-flex h-[30px] items-center gap-1.5 rounded border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2"
                >
                  <Plug size={14} />
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Tag variant="amber">Not connected</Tag>
                {sfStatus.data?.needs_reconnect ? (
                  <span className="text-[12.5px] text-amber">
                    Session expired — please reconnect.
                  </span>
                ) : null}
              </div>
              <p className="text-[12.5px] text-ink-3">
                Connect your Salesforce account to load real account, opp, and
                contact data.
              </p>
              <button
                onClick={startSalesforceConnect}
                className="inline-flex h-[30px] items-center gap-1.5 self-start rounded border border-ink bg-ink px-3 text-[13px] font-medium text-surface hover:opacity-90"
              >
                <Plug2 size={14} />
                Connect Salesforce
              </button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      {children}
    </div>
  );
}

function CardHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="border-b border-border-strong bg-surface-2 px-5 py-3">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      {subtitle ? (
        <div className="mt-1 text-[12px] text-ink-3">{subtitle}</div>
      ) : null}
    </div>
  );
}
