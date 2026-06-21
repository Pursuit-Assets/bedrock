/**
 * Jobs · Account detail — the per-account page, modeled on the portfolio
 * AccountDetail (header + sections). Reuses the account-hub query (keyed by
 * normalized company name) so navigating in from the list is instant.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";

import { AccountAvatar } from "@/components/AccountAvatar";
import { BackLink, SectionCard } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import {
  useJobsAccounts,
  useJobsStaff,
  useUpdateJobsAccount,
} from "@/services/jobs";

import { ContactsLinkTab, OppsTab, OwnerSelect } from "@/components/jobs/jobsEntity";

function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border-strong bg-surface px-3 py-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>
      <span className="text-[15px] font-semibold text-ink">{value}</span>
    </div>
  );
}

export function JobsAccountDetailPage() {
  const { accountKey } = useParams<{ accountKey: string }>();
  const key = decodeURIComponent(accountKey ?? "");

  const { data: accounts = [], isLoading, isError, refetch } = useJobsAccounts();
  const account = useMemo(() => accounts.find((a) => a.account_key === key), [accounts, key]);

  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();

  if (isLoading) {
    return <div className="px-7 py-6 text-[13px] text-ink-3">Loading account…</div>;
  }
  if (isError) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs" defaultLabel="Jobs" />
        <p className="text-[13px] text-red">Couldn't load accounts.</p>
        <button type="button" onClick={() => refetch()} className="self-start rounded border border-border-strong px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2">Retry</button>
      </div>
    );
  }
  if (!account) {
    return (
      <div className="flex flex-col gap-3 px-7 py-6">
        <BackLink defaultTo="/jobs" defaultLabel="Jobs" />
        <p className="text-[13px] text-ink-3">Account "{key}" not found in the jobs pipeline.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-7 py-4 pb-12">
      <BackLink defaultTo="/jobs" defaultLabel="Jobs" />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <AccountAvatar name={account.account} logoUrl={null} size={32} />
        <h1 className="text-[20px] font-semibold text-ink">{account.account}</h1>
        <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Owner</span>
          <OwnerSelect
            owner={account.owner_email}
            staff={staff}
            onSave={(email) => updateAccount.mutateAsync({ account: account.account, owner_email: email })}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Status" value={account.account_status} />
        <Stat label="Opportunities" value={account.opp_count} />
        <Stat label="Contacts" value={account.prospect_count} />
        <Stat label="Last activity" value={relativeDays(account.last_activity)} />
      </div>

      {/* Sections */}
      <SectionCard title={`Opportunities (${account.opp_count})`} storageScope="jobs-account" defaultOpen>
        <OppsTab opps={account.opportunities} />
      </SectionCard>

      <SectionCard title={`Contacts (${account.prospect_count})`} storageScope="jobs-account" defaultOpen>
        <ContactsLinkTab contacts={account.prospects} />
      </SectionCard>
    </div>
  );
}
