import { NavLink, Outlet, useLocation, useNavigationType } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Building2,
  GitBranch,
  Trophy,
  FolderOpen,
  Users,
  Search,
  Sparkles,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Link as LinkIcon,
  Home,
  MessageSquarePlus,
} from "lucide-react";

import { GlobalSearch } from "@/components/GlobalSearch";
import { cn } from "@/lib/utils";
import { recordNavigation, saveScroll, restoreScroll } from "@/lib/navHistory";
import { useCurrentUser, useSalesforceStatus, startSalesforceConnect } from "@/services/auth";

const NAV_GROUPS = [
  {
    label: "Performance",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/cashflow",  label: "Cash Flow", icon: TrendingUp },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { to: "/portfolio", label: "Home",     icon: Home },
      { to: "/accounts", label: "Accounts", icon: Building2 },
      { to: "/contacts", label: "Contacts", icon: Users },
      { to: "/pipeline", label: "Pipeline", icon: GitBranch },
      { to: "/awards",   label: "Awards",   icon: Trophy },
      { to: "/projects", label: "Projects", icon: FolderOpen },
      { to: "/cleanup",  label: "Cleanup",  icon: Sparkles },
      // Tasks page hidden 2026-05-04 — pending a Salesforce data-hygiene
      // pass to close the years-old open-task backlog. Tasks remain
      // visible on the per-record expand panels and detail pages, where
      // scoping makes the noise tractable. To restore the global page,
      // re-add `{ to: "/tasks", label: "Tasks", icon: CheckSquare }` and
      // re-import CheckSquare from lucide-react. Route at App.tsx is
      // still wired so direct URLs continue to work.
    ],
  },
] as const;

const NAV_COLLAPSED_W = 52;
const NAV_EXPANDED_W = 232;

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("bedrock:sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("bedrock:sidebar-collapsed", String(next)); } catch {}
      return next;
    });
  return { collapsed, toggle };
}

export function AppShell() {
  const { collapsed, toggle } = useSidebarCollapsed();
  const [searchOpen, setSearchOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const sf = useSalesforceStatus();

  // Pages that don't fundamentally need Salesforce — Settings (so the user
  // can connect SF), Projects (planning lives in Bedrock's own DB), and
  // Feedback (intake form). Anything else 503s the SF gate when SF is off.
  const SF_OPTIONAL_PREFIXES = ["/settings", "/projects", "/feedback"];
  const sfOptional = SF_OPTIONAL_PREFIXES.some((p) => pathname.startsWith(p));
  const sfNotConnected = !sf.isLoading && sf.data?.connected === false;

  const navType = useNavigationType();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    const prev = prevPathRef.current;
    prevPathRef.current = pathname;

    // Save scroll position of the page we're leaving
    if (prev !== pathname && scrollRef.current) {
      saveScroll(prev, scrollRef.current.scrollTop);
    }

    if (navType === "POP") {
      // Back/forward — restore the saved scroll position
      const saved = restoreScroll(pathname);
      if (saved !== null && scrollRef.current) {
        // Defer so the DOM has time to render before scrolling
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: saved });
        });
      }
    } else {
      // Forward navigation — scroll to top
      scrollRef.current?.scrollTo({ top: 0 });
    }
    recordNavigation();
  }, [pathname, navType]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      className="grid h-screen overflow-hidden transition-[grid-template-columns] duration-200"
      style={{
        gridTemplateColumns: `${collapsed ? NAV_COLLAPSED_W : NAV_EXPANDED_W}px 1fr`,
      }}
    >
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Sidebar collapsed={collapsed} onToggle={toggle} onSearchOpen={() => setSearchOpen(true)} />
      <main className="flex flex-col overflow-hidden">
        {sfNotConnected && !sfOptional ? (
          <SalesforceGate />
        ) : (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  );
}

function SalesforceGate() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-ink-3">
        <LinkIcon size={22} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[17px] font-semibold text-ink">Connect Salesforce</h2>
        <p className="max-w-[340px] text-[13px] text-ink-3">
          Bedrock reads and writes directly to your Salesforce org. Connect your account to get started.
        </p>
      </div>
      <button
        type="button"
        onClick={startSalesforceConnect}
        className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-surface hover:opacity-90"
      >
        Connect Salesforce
      </button>
      <p className="text-[11.5px] text-ink-4">
        You can also connect in{" "}
        <a href="/settings" className="underline hover:text-ink-2">
          Settings → Connections
        </a>
      </p>
    </div>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  onSearchOpen,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onSearchOpen: () => void;
}) {
  const { data: user } = useCurrentUser();
  const sf = useSalesforceStatus();

  return (
    <aside
      className={cn(
        "relative flex flex-col gap-1 overflow-hidden border-r border-border bg-surface-2 transition-all duration-200",
        collapsed ? "p-2" : "p-3",
      )}
    >
      {/* Logo / wordmark — toggle lives in this row, anchored to the
          right edge when expanded and stacked under the logo when
          collapsed (so it can't overlap the user avatar at bottom). */}
      <div
        className={cn(
          "flex items-center gap-2 px-1 py-3",
          collapsed && "flex-col gap-2 px-0",
        )}
      >
        <div className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md bg-ink text-[13px] font-bold tracking-tight text-surface">
          B
        </div>
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-tight">Bedrock</span>
            <span className="text-[11px] text-ink-3">Pursuit · Workspace</span>
          </div>
        )}
        <button
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-ink-3 hover:bg-black/[0.05] hover:text-ink",
            !collapsed && "ml-auto",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
      </div>

      {/* Search trigger — hidden when collapsed */}
      {!collapsed && (
        <button
          type="button"
          onClick={onSearchOpen}
          className="mb-2 mt-1 flex h-[30px] w-full items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-ink-3 hover:border-ink-3 hover:bg-surface-2"
        >
          <Search size={13} className="flex-shrink-0" />
          <span className="min-w-0 flex-1 text-[12.5px] text-ink-4">
            Search…
          </span>
          <kbd className="rounded border border-border-strong px-1.5 py-px text-[10px] text-ink-3">
            ⌘K
          </kbd>
        </button>
      )}

      <nav className="flex flex-col">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                {group.label}
              </div>
            )}
            <div className="flex flex-col gap-px">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
                      collapsed
                        ? "h-9 w-9 justify-center"
                        : "gap-2.5 px-2.5 py-1.5",
                      isActive &&
                        "border border-border-strong bg-surface text-ink shadow-sm",
                    )
                  }
                >
                  <item.icon size={16} className="flex-shrink-0 opacity-70" />
                  {!collapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-px pt-4">
        <NavLink
          to="/feedback"
          title={collapsed ? "Bug reports & feature requests" : undefined}
          className={({ isActive }) =>
            cn(
              "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
              collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-2.5 py-1.5",
              isActive && "border border-border-strong bg-surface text-ink shadow-sm",
            )
          }
        >
          <MessageSquarePlus size={16} className="flex-shrink-0 opacity-70" />
          {!collapsed && <span>Feedback</span>}
        </NavLink>
        <NavLink
          to="/settings"
          title={
            collapsed
              ? sf.data?.connected
                ? `Settings · SF: ${sf.data.user_name ?? "connected"}`
                : "Settings · Salesforce not connected"
              : undefined
          }
          className={({ isActive }) =>
            cn(
              "flex select-none items-center rounded-md text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink",
              collapsed ? "h-9 w-9 justify-center" : "gap-2.5 px-2.5 py-1.5",
              isActive && "border border-border-strong bg-surface text-ink shadow-sm",
            )
          }
        >
          <SettingsIcon size={16} className="flex-shrink-0 opacity-70" />
          {!collapsed && (
            <>
              <span className="flex-1">Settings</span>
              {!sf.isLoading && (
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
                    sf.data?.connected ? "bg-green" : "bg-amber",
                  )}
                  title={sf.data?.connected ? `SF: ${sf.data.user_name ?? "connected"}` : "Salesforce not connected"}
                />
              )}
            </>
          )}
        </NavLink>

        {/* User avatar */}
        {user && (
          <div
            className={cn(
              "mt-2 flex items-center rounded-md px-1 py-2",
              collapsed ? "justify-center" : "gap-2 px-2.5",
            )}
          >
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                className="h-6 w-6 flex-shrink-0 rounded-full border border-border-strong"
              />
            ) : (
              <div className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-surface text-[11px] font-semibold text-ink-2">
                {user.name?.[0] ?? "?"}
              </div>
            )}
            {!collapsed && (
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[12px] font-medium">{user.name}</span>
                <span className="truncate text-[11px] text-ink-4">{user.email}</span>
              </div>
            )}
          </div>
        )}
      </div>

    </aside>
  );
}
