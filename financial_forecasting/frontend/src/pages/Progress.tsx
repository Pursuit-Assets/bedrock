import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDollarMillions } from '../utils/formatters';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  Button,
  LinearProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  CircularProgress,
  Tooltip as MuiTooltip,
  Collapse,
  IconButton,
} from '@mui/material';
import {
  TrendingUp as TrendingUpIcon,
  Warning as WarningIcon,
  CheckCircle as CheckCircleIcon,
  AttachMoney as MoneyIcon,
  ShowChart as ChartIcon,
  InfoOutlined as InfoIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import { useQuery } from 'react-query';
import { apiService } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { addQuarters, startOfQuarter, endOfQuarter, format, isWithinInterval, differenceInDays, parseISO } from 'date-fns';
import PipelineFunnel from '../components/PipelineFunnel';
import OwnerSelector, { OwnerOption, loadStoredOwnerSelection } from '../components/OwnerSelector';
import { useOwnerGoals } from '../hooks/useOwnerGoals';
import { OPEN_STAGES } from '../types/salesforce';
import ConnectPrompt from '../components/ConnectPrompt';
import OpportunityEditDialog from '../components/OpportunityEditDialog';


interface Opportunity {
  Id: string;
  Name: string;
  AccountId: string;
  Account?: { Name: string };
  StageName: string;
  Amount: number;
  Probability: number;
  CloseDate: string;
  CreatedDate: string;
  LastModifiedDate: string;
  RenewalRepeat__c?: string;
  OwnerId: string;
  Owner?: { Name: string; Id?: string };
  First_Payment_Date__c?: string;
  Payment_Frequency__c?: string;
  Payment_Amount__c?: number;
  npe01__Number_of_Payments__c?: number;
  npe01__Payments_Made__c?: number;
}

// Pursuit's Salesforce contains BOTH "Closed / Completed" (1,923 live
// records) AND "Closed Won" (575 live records) as terminal "we won" stages,
// plus "In Collection" (650) and "Collecting / In Effect" (47) for in-flight
// collections. The defensive substring match below covers all of them. Do
// NOT narrow to exact-match on OPPORTUNITY_STAGES — the enum declares 13
// stages but the live org has 22. See tasks/stage-schema-drift.md for the
// full gap + deferred fixes pending a glossary conversation.
const CLOSED_WON_STAGES = ['Closed Won', 'Closed / Completed', 'Collecting / In Effect', 'Collecting', 'In Collection', 'In Effect'];
const CLOSED_LOST_STAGES = ['Closed Lost', 'Withdrawn', 'Did not Fulfill', 'Closed / Did not Fulfill'];

const Progress: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { sfUserId } = usePermissions();
  // Wall of Progress fiscal year — Pursuit's FY = calendar year
  const currentFiscalYear = useMemo(() => new Date().getFullYear(), []);
  const { goals: ownerGoals, isLoading: goalsLoading } = useOwnerGoals(currentFiscalYear);

  const [selectedOwnerIds, setSelectedOwnerIds] = useState<string[]>([]);
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);
  const [expandedOwnerId, setExpandedOwnerId] = useState<string | null>(null);
  // Opportunity edit drawer — opened by clicking a row inside the owner
  // expansion (Wins or Open Pipeline). See BUG-UI-1.
  const [editOpp, setEditOpp] = useState<Opportunity | null>(null);

  // Fetch opportunities
  const { data: opportunitiesData, isLoading: oppsLoading } = useQuery(
    'opportunities',
    async () => {
      const response = await apiService.getOpportunities();
      return response.data;
    }
  );

  // Ensure opportunities is always an array (wrapped in useMemo so referential
  // identity is stable across renders, preventing dependent useMemos from re-running)
  const opportunities: Opportunity[] = useMemo(
    () =>
      Array.isArray(opportunitiesData)
        ? opportunitiesData
        : (opportunitiesData?.opportunities || opportunitiesData?.data || []),
    [opportunitiesData],
  );

  // Fetch active SF users directly. The Bedrock "progress-tracked override"
  // concept was removed (BUG-UI-19, 2026-04-21): service accounts and
  // non-revenue-tracked staff are filtered out naturally by (a) the absence
  // of a revenue target in Settings → Targets and (b) not owning any open
  // opportunities in Salesforce — no third per-user toggle needed.
  const { data: sfUsersData, isLoading: usersLoading } = useQuery(
    'sf-users-progress',
    async () => {
      const res = await apiService.getUsers({ limit: 1000 });
      return res.data?.data || res.data?.users || res.data || [];
    },
    { staleTime: 300000 },
  );

  // Normalize to the {Id, Name, IsActive} shape the rest of this component uses.
  const allUsers = useMemo<
    Array<{ Id: string; Name: string; IsActive: boolean }>
  >(
    () =>
      (Array.isArray(sfUsersData) ? sfUsersData : []).map((u: any) => ({
        Id: u.Id,
        Name: u.Name,
        IsActive: u.IsActive !== false,
      })),
    [sfUsersData],
  );

  // IsActive is guaranteed true by the backend (WHERE IsActive=true) but
  // the belt-and-suspenders filter here also guards against any future
  // endpoint change that widens the query.
  const activeUsers = useMemo(
    () => allUsers.filter((u) => u.IsActive),
    [allUsers],
  );

  // ── Wall of Progress: derive available owners from currently-open opps ──
  const availableOpenOwners = useMemo<OwnerOption[]>(() => {
    const seen = new Map<string, string>();
    for (const opp of opportunities) {
      if (OPEN_STAGES.includes(opp.StageName as any) && opp.OwnerId && !seen.has(opp.OwnerId)) {
        seen.set(opp.OwnerId, opp.Owner?.Name || opp.OwnerId);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [opportunities]);

  // Opportunities passed to the funnel: filtered by selection (or all if empty)
  const opportunitiesForFunnel = useMemo(() => {
    if (selectedOwnerIds.length === 0) return opportunities;
    const set = new Set(selectedOwnerIds);
    return opportunities.filter((o) => set.has(o.OwnerId));
  }, [opportunities, selectedOwnerIds]);

  // Calculate metrics
  const metrics = useMemo(() => {
    if (!opportunities) return null;

    const now = new Date();
    const currentQuarterStart = startOfQuarter(now);
    const currentQuarterEnd = endOfQuarter(now);

    // Filter open opportunities - only include stages actively being pursued
    const openOpps = opportunities.filter((opp: Opportunity) => {
      return OPEN_STAGES.includes(opp.StageName as any);
    });

    // Total pipeline (open only — wins added after allWonOpps is computed)
    const openPipeline = openOpps.reduce((sum: number, opp: Opportunity) => sum + (opp.Amount || 0), 0);
    
    // Weighted pipeline
    const weightedPipeline = openOpps.reduce(
      (sum: number, opp: Opportunity) => sum + ((opp.Amount || 0) * (opp.Probability || 0)) / 100,
      0
    );

    const weightedValue = (opp: Opportunity) => ((opp.Amount || 0) * (opp.Probability || 0)) / 100;
    const isRenewal = (opp: Opportunity) => opp.RenewalRepeat__c === 'Renewal';

    // Won opps (Collecting / Closed Won / Closed Completed) — count at full value (100%)
    const allWonOpps = opportunities.filter((opp: Opportunity) =>
      CLOSED_WON_STAGES.some(stage => opp.StageName?.includes(stage))
    );
    const totalWins = allWonOpps.reduce((s, o) => s + (o.Amount || 0), 0);
    const totalPipeline = openPipeline + totalWins;

    // Upside/Base/Downside = wins (at 100%) + open pipeline (probability-weighted)
    const upside = totalWins + weightedPipeline;

    const baseCaseOpps = openOpps.filter((opp: Opportunity) => isRenewal(opp) || (opp.Probability || 0) >= 50);
    const baseCase = totalWins + baseCaseOpps.reduce((sum: number, opp: Opportunity) => sum + weightedValue(opp), 0);

    const downsideOpps = openOpps.filter((opp: Opportunity) => isRenewal(opp) || (opp.Probability || 0) >= 70);
    const downside = totalWins + downsideOpps.reduce((sum: number, opp: Opportunity) => sum + weightedValue(opp), 0);

    // Current quarter opportunities
    const currentQuarterOpps = openOpps.filter((opp: Opportunity) => {
      if (!opp.CloseDate) return false;
      const closeDate = parseISO(opp.CloseDate);
      return isWithinInterval(closeDate, { start: currentQuarterStart, end: currentQuarterEnd });
    });

    const currentQuarterValue = currentQuarterOpps.reduce((sum: number, opp: Opportunity) => sum + (opp.Amount || 0), 0);
    const currentQuarterWeighted = currentQuarterOpps.reduce(
      (sum: number, opp: Opportunity) => sum + ((opp.Amount || 0) * (opp.Probability || 0)) / 100,
      0
    );

    // At-risk deals (in current quarter but low probability or early stage)
    const atRiskDeals = currentQuarterOpps.filter((opp: Opportunity) => {
      return (opp.Probability || 0) < 50 || 
             ['Lead Gen', 'New Lead', 'Qualifying'].includes(opp.StageName || '');
    });
    const atRiskHighValueCount = atRiskDeals.filter((opp: Opportunity) => (opp.Amount || 0) >= 250000).length;

    // Stale opportunities
    const staleOpps = openOpps.filter((opp: Opportunity) => {
      if (!opp.CloseDate) return false;
      const closeDate = parseISO(opp.CloseDate);
      const isPastDue = closeDate < now;
      
      // Check if in same stage for 30+ days
      const lastModified = opp.LastModifiedDate ? parseISO(opp.LastModifiedDate) : parseISO(opp.CreatedDate);
      const daysSinceUpdate = differenceInDays(now, lastModified);
      const notUpdated = daysSinceUpdate > 30;

      return isPastDue || notUpdated;
    });

    // High-value stagnant: $250k+ with no activity in 30+ days
    const highValueStagnantOpps = openOpps.filter((opp: Opportunity) => {
      const lastModified = opp.LastModifiedDate ? parseISO(opp.LastModifiedDate) : parseISO(opp.CreatedDate);
      const daysSinceUpdate = differenceInDays(now, lastModified);
      return (opp.Amount || 0) >= 250000 && daysSinceUpdate > 30;
    });

    // Win rate (trailing 12 months)
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    
    const closedOpps = opportunities.filter((opp: Opportunity) => {
      if (!opp.CloseDate) return false;
      const closeDate = parseISO(opp.CloseDate);
      const isClosed = CLOSED_WON_STAGES.some(stage => opp.StageName?.includes(stage)) ||
                       CLOSED_LOST_STAGES.some(stage => opp.StageName?.includes(stage));
      return isClosed && closeDate >= twelveMonthsAgo;
    });

    const wonOpps = closedOpps.filter((opp: Opportunity) =>
      CLOSED_WON_STAGES.some(stage => opp.StageName?.includes(stage))
    );
    
    const winRate = closedOpps.length > 0 ? (wonOpps.length / closedOpps.length) * 100 : 0;

    // Pipeline by stage (ordered funnel)
    const stageBreakdown: { [key: string]: { count: number; total: number; weighted: number } } = {};
    openOpps.forEach((opp: Opportunity) => {
      const stage = opp.StageName || 'Unknown';
      if (!stageBreakdown[stage]) {
        stageBreakdown[stage] = { count: 0, total: 0, weighted: 0 };
      }
      stageBreakdown[stage].count++;
      stageBreakdown[stage].total += opp.Amount || 0;
      stageBreakdown[stage].weighted += ((opp.Amount || 0) * (opp.Probability || 0)) / 100;
    });

    // Get won opportunities for cash flow projections
    const wonOppsForPayments = opportunities.filter((opp: Opportunity) =>
      CLOSED_WON_STAGES.some(stage => opp.StageName?.includes(stage))
    );

    // Helper function to calculate FUTURE payment schedule for an opportunity
    const getFuturePaymentDates = (opp: Opportunity): Date[] => {
      const dates: Date[] = [];
      
      if (opp.First_Payment_Date__c && opp.npe01__Number_of_Payments__c && opp.npe01__Number_of_Payments__c > 0) {
        // Use actual payment schedule
        const firstDate = parseISO(opp.First_Payment_Date__c);
        const numPayments = opp.npe01__Number_of_Payments__c;
        const frequency = opp.Payment_Frequency__c?.toLowerCase() || 'monthly';
        
        for (let i = 0; i < numPayments; i++) {
          let paymentDate = new Date(firstDate);
          
          // Calculate payment date based on frequency
          if (frequency.includes('annual') || frequency.includes('year')) {
            paymentDate.setFullYear(firstDate.getFullYear() + i);
          } else if (frequency.includes('quarter')) {
            paymentDate.setMonth(firstDate.getMonth() + (i * 3));
          } else if (frequency.includes('semi') || frequency.includes('bi-annual')) {
            paymentDate.setMonth(firstDate.getMonth() + (i * 6));
          } else { // default to monthly
            paymentDate.setMonth(firstDate.getMonth() + i);
          }
          
          // Only include future or current payments (not past ones)
          if (paymentDate >= now) {
            dates.push(paymentDate);
          }
        }
      } else if (opp.CloseDate) {
        // Fallback: use close date as payment date
        const closeDate = parseISO(opp.CloseDate);
        // Only include if it's in the future
        if (closeDate >= now) {
          dates.push(closeDate);
        }
      }
      
      return dates;
    };

    // Cash flow by quarter - includes BOTH open pipeline and won opportunities
    const quarters: { [key: string]: { open: number; won: number; total: number } } = {};
    for (let i = 0; i < 8; i++) {
      const quarterStart = addQuarters(currentQuarterStart, i);
      const quarterEnd = endOfQuarter(quarterStart);
      const quarterLabel = format(quarterStart, 'QQQ yyyy');

      let openValue = 0;
      let wonValue = 0;

      // Open opportunities - weighted by probability, distributed across payment schedule
      openOpps.forEach((opp: Opportunity) => {
        const paymentDates = getFuturePaymentDates(opp);
        if (paymentDates.length === 0) return; // Skip if no future payments
        
        const amountPerPayment = (opp.Amount || 0) / Math.max(paymentDates.length, 1);
        const weightedAmountPerPayment = (amountPerPayment * (opp.Probability || 0)) / 100;
        
        paymentDates.forEach((paymentDate) => {
          if (isWithinInterval(paymentDate, { start: quarterStart, end: quarterEnd })) {
            openValue += weightedAmountPerPayment;
          }
        });
      });

      // Won opportunities - at full value, distributed across REMAINING payment schedule
      wonOppsForPayments.forEach((opp: Opportunity) => {
        const paymentDates = getFuturePaymentDates(opp);
        if (paymentDates.length === 0) return; // Skip if no future payments
        
        // Calculate remaining amount (total minus what's already been paid)
        const totalAmount = opp.Amount || 0;
        const paidAmount = opp.npe01__Payments_Made__c || 0;
        const remainingAmount = totalAmount - paidAmount;
        
        // Distribute remaining amount across future payments
        const amountPerPayment = remainingAmount / Math.max(paymentDates.length, 1);
        
        paymentDates.forEach((paymentDate) => {
          if (isWithinInterval(paymentDate, { start: quarterStart, end: quarterEnd })) {
            wonValue += amountPerPayment;
          }
        });
      });

      quarters[quarterLabel] = {
        open: openValue,
        won: wonValue,
        total: openValue + wonValue
      };
    }

    // FY-scoped metrics (wins + open pipeline)
    const fyStart = new Date(now.getFullYear(), 0, 1);
    const fyEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    const inFY = (opp: Opportunity) => opp.CloseDate && parseISO(opp.CloseDate) >= fyStart && parseISO(opp.CloseDate) <= fyEnd;
    const fyOpenOpps = openOpps.filter(inFY);
    const fyWonOpps = allWonOpps.filter(inFY);
    const fyWins = fyWonOpps.reduce((s, o) => s + (o.Amount || 0), 0);
    const fyPipeline = fyOpenOpps.reduce((s, o) => s + (o.Amount || 0), 0) + fyWins;
    const fyUpside = fyWins + fyOpenOpps.reduce((s, o) => s + weightedValue(o), 0);
    const fyBaseCase = fyWins + fyOpenOpps.filter((o) => isRenewal(o) || (o.Probability || 0) >= 50).reduce((s, o) => s + weightedValue(o), 0);
    const fyDownside = fyWins + fyOpenOpps.filter((o) => isRenewal(o) || (o.Probability || 0) >= 70).reduce((s, o) => s + weightedValue(o), 0);

    // Per-quarter metrics (Q1–Q4). Past quarters: wins only. Current/future: wins + weighted pipeline.
    const year = now.getFullYear();
    const qMetrics = [1, 2, 3, 4].map((q) => {
      const qStart = new Date(year, (q - 1) * 3, 1);
      const qEnd = endOfQuarter(qStart);
      const isPast = qEnd < now;
      const inQ = (opp: Opportunity) => opp.CloseDate && isWithinInterval(parseISO(opp.CloseDate), { start: qStart, end: qEnd });
      const qWon = allWonOpps.filter(inQ);
      const qOpen = openOpps.filter(inQ);
      const wins = qWon.reduce((s, o) => s + (o.Amount || 0), 0);
      if (isPast) {
        return { label: `Q${q}`, wins, pipeline: 0, upside: 0, baseCase: 0, downside: 0, isPast };
      }
      const openTotal = qOpen.reduce((s, o) => s + (o.Amount || 0), 0);
      return {
        label: `Q${q}`,
        wins,
        pipeline: wins + openTotal,
        upside: wins + qOpen.reduce((s, o) => s + weightedValue(o), 0),
        baseCase: wins + qOpen.filter((o) => isRenewal(o) || (o.Probability || 0) >= 50).reduce((s, o) => s + weightedValue(o), 0),
        downside: wins + qOpen.filter((o) => isRenewal(o) || (o.Probability || 0) >= 70).reduce((s, o) => s + weightedValue(o), 0),
        isPast,
      };
    });

    return {
      totalPipeline,
      totalWins,
      weightedPipeline,
      upside,
      baseCase,
      baseCaseCount: baseCaseOpps.length,
      downside,
      downsideCount: downsideOpps.length,
      averageDealSize: openOpps.length > 0 ? totalPipeline / openOpps.length : 0,
      totalDeals: openOpps.length,
      currentQuarterValue,
      currentQuarterWeighted,
      currentQuarterCount: currentQuarterOpps.length,
      atRiskCount: atRiskDeals.length,
      atRiskDeals,
      atRiskHighValueCount,
      highValueStagnantCount: highValueStagnantOpps.length,
      highValueStagnantOpps,
      staleCount: staleOpps.length,
      staleOpps,
      winRate,
      wonCount: wonOpps.length,
      lostCount: closedOpps.length - wonOpps.length,
      stageBreakdown,
      quarters,
      // Scoped metrics for pipeline summary table
      fy: { wins: fyWins, pipeline: fyPipeline, upside: fyUpside, baseCase: fyBaseCase, downside: fyDownside },
      qMetrics,
    };
  }, [opportunities]);

  // Per-owner progress for targets table. Shows ONLY users who match all
  // three criteria (set by JP + Jac 2026-04-15):
  //   (a) FY revenue target set in Settings → Targets
  //   (b) IsActive=true in Salesforce
  //   (c) Owns at least one opportunity in Salesforce
  // Users missing a target are simply omitted from this table — no
  // "Target not set" placeholder rows. (A banner that counted them and
  // pointed at a not-yet-shipped Bulk Edit page was removed 2026-04-20.)
  const ownerIdsWithOpps = useMemo(() => {
    const ids = new Set<string>();
    for (const o of opportunities) if (o.OwnerId) ids.add(o.OwnerId);
    return ids;
  }, [opportunities]);

  // Canonical "has a target" set: goal record exists AND amount > 0. A
  // $0-amount goal (e.g. accidentally saved from the Targets dialog) is
  // NOT a target — treating it as one produced a ghost row previously
  // (row appeared but rendered "Target not set" because the display check
  // used goal_amount > 0 while the filter only truthy-checked the goal
  // record). Normalizing through this one memo eliminates the drift.
  const goalHoldersWithAmount = useMemo(() => {
    const ids = new Set<string>();
    if (ownerGoals) {
      for (const [sfId, goal] of Object.entries(ownerGoals)) {
        if (goal.goal_amount > 0) ids.add(sfId);
      }
    }
    return ids;
  }, [ownerGoals]);

  const GOAL_STAGES = useMemo(() => ['Collecting / In Effect', 'Closed / Completed'], []);
  const ownerProgress = useMemo(() => {
    if (!opportunities.length) return [];
    const now = new Date();
    const fyStart = new Date(now.getFullYear(), 0, 1);
    const fyEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    const yearPct = Math.max(0, Math.min(1, (now.getTime() - fyStart.getTime()) / (fyEnd.getTime() - fyStart.getTime())));

    // Build the eligible set: user must pass ALL THREE checks per the
    // JP + Jac alignment on 2026-04-15 — IsActive=true in SF (covered by
    // the `activeUsers` query + Bedrock override), owns ≥1 opportunity
    // (`ownerIdsWithOpps`), and has a target with amount > 0
    // (`goalHoldersWithAmount`). No historical-holder fallback — if a
    // user is IsActive=false in SF they don't appear here, regardless of
    // whether they still carry a target or opps (HR source of truth).
    const ids = new Set<string>();
    for (const u of activeUsers) {
      if (ownerIdsWithOpps.has(u.Id) && goalHoldersWithAmount.has(u.Id)) {
        ids.add(u.Id);
      }
    }

    const nameById = (sfId: string) =>
      allUsers.find((u) => u.Id === sfId)?.Name
      || availableOpenOwners.find((o) => o.id === sfId)?.name
      || opportunities.find((o) => o.OwnerId === sfId)?.Owner?.Name
      || sfId;

    return Array.from(ids).map((sfId) => {
      const goal = ownerGoals?.[sfId];
      const hasTarget = !!goal && goal.goal_amount > 0;
      const target = hasTarget ? goal.goal_amount : 0;

      const wonOpps = opportunities.filter((o) =>
        o.OwnerId === sfId &&
        GOAL_STAGES.includes(o.StageName) &&
        o.CloseDate && new Date(o.CloseDate) >= fyStart && new Date(o.CloseDate) <= fyEnd
      );
      const wins = wonOpps.reduce((s, o) => s + (o.Amount || 0), 0);

      const openOpps = opportunities.filter((o) =>
        o.OwnerId === sfId && OPEN_STAGES.includes(o.StageName as any)
      );
      const pipeline = openOpps.reduce((s, o) => s + (o.Amount || 0), 0);
      const weighted = openOpps.reduce((s, o) => s + ((o.Amount || 0) * (o.Probability || 0)) / 100, 0);

      // Projection: wins so far annualized (FY-linear). Useful even without
      // a target — shows the run-rate trajectory.
      const elapsedMonths = Math.max(1, (now.getTime() - fyStart.getTime()) / (fyEnd.getTime() - fyStart.getTime()) * 12);
      const projected = (wins / elapsedMonths) * 12;

      const remaining = hasTarget ? Math.max(0, target - wins) : 0;
      const pct = hasTarget ? Math.min(1, wins / target) : 0;
      const onTrack: 'ahead' | 'close' | 'behind' | 'none' = !hasTarget
        ? 'none'
        : pct >= yearPct ? 'ahead'
        : pct >= yearPct * 0.75 ? 'close'
        : 'behind';

      return {
        sfId,
        ownerName: nameById(sfId),
        hasTarget,
        target,
        wins,
        remaining,
        projected,
        pct,
        yearPct,
        onTrack,
        pipeline,
        weighted,
        wonOpps,
        openOpps,
      };
    }).sort((a, b) => {
      // Users with targets first (by pct desc), users without targets
      // grouped at the bottom alphabetically — keeps the "needs attention"
      // info high on the page.
      if (a.hasTarget !== b.hasTarget) return a.hasTarget ? -1 : 1;
      if (a.hasTarget) return b.pct - a.pct;
      return a.ownerName.localeCompare(b.ownerName);
    });
  }, [ownerGoals, opportunities, GOAL_STAGES, activeUsers, allUsers, availableOpenOwners, ownerIdsWithOpps, goalHoldersWithAmount]);

  // Seed the Pipeline Flow multi-select. Precedence:
  //   1. localStorage selection from a prior session (filtered to the current
  //      available-owner pool so dormant IDs drop out automatically)
  //   2. Individual Goals & Pipelines table (ownerProgress ∩ open-owner pool)
  //   3. [] — triggers the "No targets set" banner when ownerProgress is empty
  // Only runs once per mount, after all three upstream queries (opps,
  // progress-users, goals) have resolved. Before that we can't distinguish
  // "no goals set" from "goals still loading" and would race with the banner.
  useEffect(() => {
    if (hasInitializedSelection) return;
    if (oppsLoading || usersLoading || goalsLoading) return;
    const openIds = new Set(availableOpenOwners.map((o) => o.id));
    const stored = loadStoredOwnerSelection('progress-pipeline-owners', openIds);
    const seeded = stored && stored.length > 0
      ? stored
      : ownerProgress.map((r) => r.sfId).filter((id) => openIds.has(id));
    setSelectedOwnerIds(seeded);
    setHasInitializedSelection(true);
  }, [
    hasInitializedSelection,
    oppsLoading,
    usersLoading,
    goalsLoading,
    availableOpenOwners,
    ownerProgress,
  ]);

  // Aggregate totals for the "Team total" row at the top of Individual
  // Goals & Pipelines. Since the table now only contains targeted users
  // (filter above), wins/remaining/projected/target all sum across every
  // visible row — no need to split targeted/untargeted.
  const teamTotals = useMemo(() => {
    const targeted = ownerProgress.filter((r) => r.hasTarget);
    const totalTarget = targeted.reduce((s, r) => s + r.target, 0);
    const totalTargetedWins = targeted.reduce((s, r) => s + r.wins, 0);
    return {
      wins: ownerProgress.reduce((s, r) => s + r.wins, 0),
      remaining: targeted.reduce((s, r) => s + r.remaining, 0),
      projected: ownerProgress.reduce((s, r) => s + r.projected, 0),
      target: totalTarget,
      pct: totalTarget > 0 ? Math.min(1, totalTargetedWins / totalTarget) : 0,
    };
  }, [ownerProgress]);

  const formatPercent = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  if (oppsLoading) {
    return (
      <Box sx={{ width: '100%', mt: 4 }}>
        <LinearProgress />
        <Typography align="center" sx={{ mt: 2 }}>
          Loading progress...
        </Typography>
      </Box>
    );
  }

  if (!metrics || (!user?.salesforce_connected && opportunities.length === 0)) {
    return (
      <Box>
        <ConnectPrompt service="Salesforce" message="Connect Salesforce in Settings to see team progress." />
      </Box>
    );
  }

  return (
    <Box>
      {/* Page title + subtitle come from Layout's ALL_MENU_ITEMS (single
          source of truth). Previous in-page H4 "Wall of Progress" +
          "Team pipeline accountability · …" duplicated that header. */}

      {/* Current FY Overview — team-wide wins + open pipeline table */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mb: 0.25 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Current FY Overview</Typography>
        <Typography variant="caption" color="text.disabled">
          Updated {format(new Date(), 'p')}
        </Typography>
      </Box>
      <Typography variant="body2" color="textSecondary" sx={{ mb: 1.5 }}>
        Quarterly wins and open pipeline &middot; {metrics.totalDeals} active deals &middot; probability-weighted
      </Typography>

      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ bgcolor: 'grey.50' }}>
              <TableCell sx={{ fontWeight: 600 }}>Metric</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>Overall</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>FY{currentFiscalYear.toString().slice(-2)}</TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right" sx={{ fontWeight: 600, color: q.isPast ? 'text.secondary' : 'text.primary' }}>
                  {q.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {/* Wins row */}
            <TableRow>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>Wins</Typography>
                </Box>
              </TableCell>
              <TableCell align="right"><Typography variant="body2" color="text.disabled">—</Typography></TableCell>
              <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: 600, color: 'success.main' }}>{formatDollarMillions(metrics.fy.wins)}</Typography></TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right"><Typography variant="body2" sx={{ fontWeight: 600, color: 'success.main' }}>{formatDollarMillions(q.wins)}</Typography></TableCell>
              ))}
            </TableRow>
            {/* Total Pipeline row */}
            <TableRow>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <MoneyIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>Total Pipeline</Typography>
                </Box>
              </TableCell>
              <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: 700, color: 'primary.main' }}>{formatDollarMillions(metrics.totalPipeline)}</Typography></TableCell>
              <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: 600 }}>{formatDollarMillions(metrics.fy.pipeline)}</Typography></TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right">
                  {q.isPast
                    ? <Typography variant="body2" color="text.disabled">—</Typography>
                    : <Typography variant="body2" sx={{ fontWeight: 600 }}>{formatDollarMillions(q.pipeline)}</Typography>
                  }
                </TableCell>
              ))}
            </TableRow>
            {/* Upside row */}
            <TableRow>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <TrendingUpIcon sx={{ fontSize: 16, color: 'success.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>Upside</Typography>
                  <MuiTooltip title="Wins (100%) + all open opps weighted by probability" arrow><InfoIcon sx={{ fontSize: 12, color: 'text.disabled', cursor: 'help' }} /></MuiTooltip>
                </Box>
              </TableCell>
              <TableCell align="right"><Typography variant="body2" color="text.disabled">—</Typography></TableCell>
              <TableCell align="right"><Typography variant="body2">{formatDollarMillions(metrics.fy.upside)}</Typography></TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right">
                  {q.isPast
                    ? <Typography variant="body2" color="text.disabled">—</Typography>
                    : <Typography variant="body2">{formatDollarMillions(q.upside)}</Typography>
                  }
                </TableCell>
              ))}
            </TableRow>
            {/* Base Case row */}
            <TableRow>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <ChartIcon sx={{ fontSize: 16, color: 'primary.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>Base Case</Typography>
                  <MuiTooltip title="Wins (100%) + open renewals or 50%+ probability, weighted" arrow><InfoIcon sx={{ fontSize: 12, color: 'text.disabled', cursor: 'help' }} /></MuiTooltip>
                </Box>
              </TableCell>
              <TableCell align="right"><Typography variant="body2" color="text.disabled">—</Typography></TableCell>
              <TableCell align="right"><Typography variant="body2">{formatDollarMillions(metrics.fy.baseCase)}</Typography></TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right">
                  {q.isPast
                    ? <Typography variant="body2" color="text.disabled">—</Typography>
                    : <Typography variant="body2">{formatDollarMillions(q.baseCase)}</Typography>
                  }
                </TableCell>
              ))}
            </TableRow>
            {/* Downside row */}
            <TableRow>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <WarningIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>Downside</Typography>
                  <MuiTooltip title="Wins (100%) + open renewals or 70%+ probability, weighted" arrow><InfoIcon sx={{ fontSize: 12, color: 'text.disabled', cursor: 'help' }} /></MuiTooltip>
                </Box>
              </TableCell>
              <TableCell align="right"><Typography variant="body2" color="text.disabled">—</Typography></TableCell>
              <TableCell align="right"><Typography variant="body2">{formatDollarMillions(metrics.fy.downside)}</Typography></TableCell>
              {metrics.qMetrics.map((q) => (
                <TableCell key={q.label} align="right">
                  {q.isPast
                    ? <Typography variant="body2" color="text.disabled">—</Typography>
                    : <Typography variant="body2">{formatDollarMillions(q.downside)}</Typography>
                  }
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>


      {/* ── Individual Goals & Pipelines — one row per targeted team member ── */}
      <Box sx={{ mb: 1, mt: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.25 }}>
          Individual Goals &amp; Pipelines
        </Typography>
        <Typography variant="body2" color="textSecondary">
          FY{currentFiscalYear.toString().slice(-2)} revenue goal vs. actuals per team member.
        </Typography>
      </Box>

      {ownerProgress.length === 0 ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          No FY{currentFiscalYear} targets set yet. Add targets in Settings &rarr; Targets.
        </Alert>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: 'grey.50' }}>
                <TableCell sx={{ width: 32 }} />
                <TableCell sx={{ fontWeight: 600 }}>Owner</TableCell>
                <TableCell sx={{ fontWeight: 600, width: '40%' }}>Progress</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Wins</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Remaining</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Projected</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>Target</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* Team total — aggregate of all visible rows. Non-expandable
                  (no chevron / no onClick) and visually weightier than body
                  rows so it reads as the summary line. */}
              <TableRow sx={{ bgcolor: 'grey.50', '& td': { fontWeight: 700 } }}>
                <TableCell sx={{ width: 32 }} />
                <TableCell>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>Team total</Typography>
                </TableCell>
                <TableCell>
                  <Box sx={{ position: 'relative' }}>
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, teamTotals.pct * 100)}
                      sx={{ height: 18, borderRadius: 1, bgcolor: 'grey.200' }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        position: 'absolute', left: '50%', top: '50%',
                        transform: 'translate(-50%, -50%)',
                        fontWeight: 700, fontSize: '0.65rem',
                        // Label is center-anchored at the 50% mark, so white
                        // text only becomes readable once the fill clearly
                        // passes that point (~0.55 accounts for half the
                        // text width). Below the threshold, keep dark text
                        // so it renders on the light-grey unfilled track.
                        color: teamTotals.pct > 0.55 ? 'white' : 'text.primary',
                      }}
                    >
                      {(teamTotals.pct * 100).toFixed(0)}%
                    </Typography>
                  </Box>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" sx={{ fontWeight: 700, color: teamTotals.wins > 0 ? 'success.main' : 'text.disabled' }}>
                    {teamTotals.wins > 0 ? formatDollarMillions(teamTotals.wins) : '—'}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" sx={{ fontWeight: 700, color: teamTotals.remaining > 0 ? 'text.primary' : 'success.main' }}>
                    {teamTotals.remaining > 0 ? formatDollarMillions(teamTotals.remaining) : 'Met'}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {teamTotals.projected > 0 ? formatDollarMillions(teamTotals.projected) : '—'}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {teamTotals.target > 0 ? formatDollarMillions(teamTotals.target) : '—'}
                  </Typography>
                </TableCell>
              </TableRow>
              {ownerProgress.map((row) => {
                const isExpanded = expandedOwnerId === row.sfId;
                const statusColor = row.onTrack === 'ahead' ? 'success' : row.onTrack === 'close' ? 'warning' : 'error';
                return (
                  <React.Fragment key={row.sfId}>
                    <TableRow
                      hover
                      sx={{
                        cursor: 'pointer',
                        // De-emphasize untargeted users — keeps the "needs
                        // attention" (targeted) rows visually dominant so
                        // eyes don't have to compete with the dim rows.
                        opacity: row.hasTarget ? 1 : 0.55,
                        '& > td': { borderBottom: isExpanded ? 'none' : undefined },
                      }}
                      onClick={() => setExpandedOwnerId(isExpanded ? null : row.sfId)}
                    >
                      <TableCell sx={{ px: 0.5 }}>
                        <IconButton size="small">
                          {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                        </IconButton>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{row.ownerName}</Typography>
                      </TableCell>
                      <TableCell>
                        {row.hasTarget ? (
                          <Box sx={{ position: 'relative' }}>
                            <LinearProgress
                              variant="determinate"
                              value={Math.min(100, row.pct * 100)}
                              color={statusColor as any}
                              sx={{ height: 18, borderRadius: 1, bgcolor: 'grey.100' }}
                            />
                            {/* Year-progress marker */}
                            <MuiTooltip title={`Today: ${(row.yearPct * 100).toFixed(0)}% through FY`} arrow placement="top">
                              <Box
                                sx={{
                                  position: 'absolute',
                                  left: `${row.yearPct * 100}%`,
                                  top: -2,
                                  bottom: -2,
                                  width: 2,
                                  bgcolor: 'text.primary',
                                  opacity: 0.7,
                                  zIndex: 1,
                                  '&::after': {
                                    content: '""',
                                    position: 'absolute',
                                    top: -3,
                                    left: -3,
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    bgcolor: 'text.primary',
                                    opacity: 0.7,
                                  },
                                }}
                              />
                            </MuiTooltip>
                            {/* Percentage label — dark until fill clearly
                                passes the center-anchored label position
                                (~0.55 threshold accounts for half the text
                                width). See matching threshold on the team
                                total row above. */}
                            <Typography
                              variant="caption"
                              sx={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontWeight: 700, fontSize: '0.65rem', color: row.pct > 0.55 ? 'white' : 'text.primary', zIndex: 2 }}
                            >
                              {(row.pct * 100).toFixed(0)}%
                            </Typography>
                          </Box>
                        ) : (
                          <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                            Target not set
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" sx={{ fontWeight: 600, color: row.wins > 0 ? 'success.main' : 'text.disabled' }}>
                          {row.wins > 0 ? formatDollarMillions(row.wins) : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {row.hasTarget ? (
                          <Typography variant="body2" color={row.remaining > 0 ? 'text.primary' : 'success.main'}>
                            {row.remaining > 0 ? formatDollarMillions(row.remaining) : 'Met'}
                          </Typography>
                        ) : (
                          <Typography variant="body2" color="text.disabled">—</Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Typography
                          variant="body2"
                          sx={{ color: row.hasTarget
                            ? (row.projected >= row.target ? 'success.main' : 'warning.main')
                            : 'text.secondary' }}
                        >
                          {row.projected > 0 ? formatDollarMillions(row.projected) : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {row.hasTarget ? (
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>{formatDollarMillions(row.target)}</Typography>
                        ) : (
                          <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>Not set</Typography>
                        )}
                      </TableCell>
                    </TableRow>

                    {/* Expanded detail */}
                    <TableRow>
                      <TableCell colSpan={7} sx={{ py: 0, borderBottom: isExpanded ? undefined : 'none' }}>
                        <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                          <Box sx={{ py: 2, px: 2 }}>
                            <Grid container spacing={3}>
                              {/* Wins */}
                              <Grid item xs={12} md={6}>
                                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'success.main' }}>
                                  Wins ({row.wonOpps.length}) &mdash; {formatDollarMillions(row.wins)}
                                </Typography>
                                {row.wonOpps.length === 0 ? (
                                  <Typography variant="body2" color="text.secondary">No closed deals yet this FY.</Typography>
                                ) : (
                                  <Table size="small">
                                    <TableBody>
                                      {row.wonOpps.slice(0, 10).map((opp: Opportunity) => (
                                        <TableRow
                                          key={opp.Id}
                                          hover
                                          onClick={() => setEditOpp(opp)}
                                          sx={{ cursor: 'pointer' }}
                                        >
                                          <TableCell sx={{ py: 0.5, pl: 0 }}>
                                            <Typography variant="body2" noWrap sx={{ maxWidth: 250 }}>{opp.Name}</Typography>
                                          </TableCell>
                                          <TableCell align="right" sx={{ py: 0.5 }}>
                                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{formatDollarMillions(opp.Amount)}</Typography>
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                      {row.wonOpps.length > 10 && (
                                        <TableRow><TableCell colSpan={2} sx={{ py: 0.5 }}>
                                          <Typography variant="caption" color="text.secondary">+{row.wonOpps.length - 10} more</Typography>
                                        </TableCell></TableRow>
                                      )}
                                    </TableBody>
                                  </Table>
                                )}
                              </Grid>

                              {/* Pipeline needed to close */}
                              <Grid item xs={12} md={6}>
                                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1, color: 'primary.main' }}>
                                  Open Pipeline ({row.openOpps.length}) &mdash; {formatDollarMillions(row.pipeline)}
                                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                                    Weighted: {formatDollarMillions(row.weighted)}
                                  </Typography>
                                </Typography>
                                {row.remaining <= 0 ? (
                                  <Chip label="Target met" color="success" size="small" />
                                ) : (
                                  <>
                                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                                      Needs {formatDollarMillions(row.remaining)} more to hit target
                                    </Typography>
                                    {row.openOpps.length === 0 ? (
                                      <Typography variant="body2" color="warning.main">No open pipeline. Needs new opportunities.</Typography>
                                    ) : (
                                      <Table size="small">
                                        <TableBody>
                                          {row.openOpps
                                            .sort((a: Opportunity, b: Opportunity) => ((b.Amount || 0) * (b.Probability || 0)) - ((a.Amount || 0) * (a.Probability || 0)))
                                            .slice(0, 10)
                                            .map((opp: Opportunity) => (
                                              <TableRow
                                                key={opp.Id}
                                                hover
                                                onClick={() => setEditOpp(opp)}
                                                sx={{ cursor: 'pointer' }}
                                              >
                                                <TableCell sx={{ py: 0.5, pl: 0 }}>
                                                  <Typography variant="body2" noWrap sx={{ maxWidth: 220 }}>{opp.Name}</Typography>
                                                  <Typography variant="caption" color="text.secondary">{opp.StageName} &middot; {opp.Probability}%</Typography>
                                                </TableCell>
                                                <TableCell align="right" sx={{ py: 0.5 }}>
                                                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{formatDollarMillions(opp.Amount)}</Typography>
                                                </TableCell>
                                              </TableRow>
                                            ))}
                                          {row.openOpps.length > 10 && (
                                            <TableRow><TableCell colSpan={2} sx={{ py: 0.5 }}>
                                              <Typography variant="caption" color="text.secondary">+{row.openOpps.length - 10} more</Typography>
                                            </TableCell></TableRow>
                                          )}
                                        </TableBody>
                                      </Table>
                                    )}
                                  </>
                                )}
                              </Grid>
                            </Grid>
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Pipeline Flow owner filter — seeded from the Individual Goals &
          Pipelines table above, editable via Autocomplete chips. */}
      <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <OwnerSelector
          availableOwners={availableOpenOwners}
          value={selectedOwnerIds}
          onChange={setSelectedOwnerIds}
          storageKey="progress-pipeline-owners"
        />
        {hasInitializedSelection && !goalsLoading && ownerProgress.length === 0 && (
          <Typography variant="caption" sx={{ color: 'warning.main' }}>
            No targets set — showing everyone with open pipeline. Set targets in
            the Individual Goals & Pipelines table above to filter.
          </Typography>
        )}
      </Box>

      {/* Pipeline Health Funnel — driven by the multi-select selection */}
      <PipelineFunnel
        opportunities={opportunitiesForFunnel}
        selectedOwnerIds={selectedOwnerIds}
      />


      {/* Below-fold: Cash Flow + charts (lazy-loaded for faster initial paint) */}
      {/* Below-fold financial charts hidden — not ready yet */}

      {/* Opportunity Edit Dialog — opened from Wins / Open Pipeline rows */}
      <OpportunityEditDialog
        open={!!editOpp}
        onClose={() => setEditOpp(null)}
        opportunityId={editOpp?.Id ?? null}
        initialData={editOpp as any}
        onSaved={() => setEditOpp(null)}
      />
    </Box>
  );
};

export default Progress;
