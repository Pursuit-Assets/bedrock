import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Box,
  IconButton,
  InputBase,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Tooltip,
  Typography,
  Alert,
  Divider,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Search as SearchIcon,
  MonetizationOn as MonetizationOnIcon,
  Business as BusinessIcon,
  Person as PersonIcon,
  OpenInNew as OpenInNewIcon,
  Close as CloseIcon,
  History as HistoryIcon,
  Clear as ClearIcon,
  Assignment as AssignmentIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';

import { apiService } from '../services/api';
import { getStageHexColor } from '../types/salesforce';
import { formatDollar } from '../utils/formatters';

// ── Types ───────────────────────────────────────────────────────────────────

interface GlobalSearchProps {
  onOpenOpportunity: (id: string, data?: Record<string, any>) => void;
  onOpenAccount: (id: string, data?: Record<string, any>) => void;
  onOpenContact: (id: string, data?: Record<string, any>) => void;
  onOpenTask: (taskId: string, whatId: string | null, taskData?: Record<string, any>) => void;
  hasOpenDialog: boolean;
}

interface SearchResults {
  Opportunity: Record<string, any>[];
  Account: Record<string, any>[];
  Contact: Record<string, any>[];
  Task: Record<string, any>[];
}

type EntityType = 'Opportunity' | 'Account' | 'Contact' | 'Task';

interface FlatResult extends Record<string, any> {
  _type: EntityType;
}

// ── History helpers (localStorage) ──────────────────────────────────────────

const HISTORY_KEY = 'bedrock-search-history';
const MAX_HISTORY = 10;

function getHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function addToHistory(q: string) {
  if (!q.trim()) return;
  const history = getHistory().filter((h) => h !== q);
  history.unshift(q);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function removeFromHistory(q: string) {
  const history = getHistory().filter((h) => h !== q);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

// ── Cache array extraction ──────────────────────────────────────────────────
// Opportunities cache shape varies — matches extractOppsArray in OpportunityEditDialog.tsx:67-74

function toArray(cached: unknown): Record<string, any>[] {
  if (Array.isArray(cached)) return cached;
  if (cached && typeof cached === 'object') {
    const obj = cached as Record<string, any>;
    return obj.opportunities || obj.data || [];
  }
  return [];
}

// ── Pipeline tab mapping ────────────────────────────────────────────────────

const TAB_NAMES: Record<EntityType, string> = {
  Opportunity: 'opportunities',
  Account: 'accounts',
  Contact: 'contacts',
  Task: 'tasks',
};

const ENTITY_ICONS: Record<EntityType, React.ReactElement> = {
  Opportunity: <MonetizationOnIcon sx={{ fontSize: 18 }} />,
  Account: <BusinessIcon sx={{ fontSize: 18 }} />,
  Contact: <PersonIcon sx={{ fontSize: 18 }} />,
  Task: <AssignmentIcon sx={{ fontSize: 18 }} />,
};

const MAX_PER_TYPE = 5;

// ── Component ───────────────────────────────────────────────────────────────

const GlobalSearch: React.FC<GlobalSearchProps> = ({
  onOpenOpportunity,
  onOpenAccount,
  onOpenContact,
  onOpenTask,
  hasOpenDialog,
}) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── State ───────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0); // triggers re-read
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const popoverOpen = Boolean(anchorEl);

  // ── Debounce ────────────────────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(timerRef.current);
    if (query.length < 2) {
      setDebouncedQuery('');
      return;
    }
    timerRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  // ── Source 1: Local cache (instant) ─────────────────────────────────────
  // useMemo is required to keep a stable reference — without it, displayResults
  // changes every render and the highlight-reset effect fires continuously,
  // breaking keyboard navigation. The queryClient cache is read as a snapshot;
  // it refreshes on each keystroke (query change) which is sufficient since
  // prefetch completes within seconds of login.
  const localResults = useMemo<SearchResults | null>(() => {
    if (query.length < 2) return null;
    const q = query.toLowerCase();
    return {
      Opportunity: toArray(queryClient.getQueryData('opportunities'))
        .filter((o) => o.Name?.toLowerCase().includes(q))
        .slice(0, MAX_PER_TYPE),
      Account: ((queryClient.getQueryData('accounts') as any[]) || [])
        .filter((a) => a.Name?.toLowerCase().includes(q))
        .slice(0, MAX_PER_TYPE),
      Contact: ((queryClient.getQueryData('all-contacts') as any[]) || [])
        .filter(
          (c) =>
            c.Name?.toLowerCase().includes(q) ||
            c.FirstName?.toLowerCase().includes(q) ||
            c.LastName?.toLowerCase().includes(q) ||
            c.Email?.toLowerCase().includes(q),
        )
        .slice(0, MAX_PER_TYPE),
      Task: ((queryClient.getQueryData('my-tasks') as any[]) || [])
        .filter((t: any) => t.Subject?.toLowerCase().includes(q))
        .slice(0, MAX_PER_TYPE),
    };
  }, [query, queryClient]);

  // ── Source 2: SOSL (debounced, authoritative) ───────────────────────────
  const {
    data: soslResults,
    isLoading: soslLoading,
    isError: soslError,
  } = useQuery<SearchResults>(
    ['global-search', debouncedQuery],
    ({ signal }) =>
      apiService.globalSearch(debouncedQuery, 10, signal).then((r) => r.data),
    {
      enabled: debouncedQuery.length >= 2,
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  // ── Merged display ─────────────────────────────────────────────────────
  // Only use SOSL results when they match the current query to prevent stale
  // data from a previous debounced query flashing on screen during rapid typing.
  const soslCurrent = soslResults && debouncedQuery === query;
  const displayResults = soslCurrent ? soslResults : localResults;
  // Show progress bar during debounce window AND while SOSL is loading.
  const isSearching = query.length >= 2 && !soslCurrent;

  // ── Flat array for keyboard navigation ─────────────────────────────────
  const flatResults = useMemo<FlatResult[]>(() => {
    if (!displayResults) return [];
    return [
      ...displayResults.Opportunity.slice(0, MAX_PER_TYPE).map((r) => ({
        ...r,
        _type: 'Opportunity' as const,
      })),
      ...displayResults.Account.slice(0, MAX_PER_TYPE).map((r) => ({
        ...r,
        _type: 'Account' as const,
      })),
      ...displayResults.Contact.slice(0, MAX_PER_TYPE).map((r) => ({
        ...r,
        _type: 'Contact' as const,
      })),
      ...displayResults.Task.slice(0, MAX_PER_TYPE).map((r) => ({
        ...r,
        _type: 'Task' as const,
      })),
    ];
  }, [displayResults]);

  // ── History ────────────────────────────────────────────────────────────
  const showHistory = popoverOpen && query.length === 0;
  const history = useMemo(
    () => (showHistory ? getHistory() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showHistory, historyVersion],
  );

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleOpen = useCallback((el: HTMLElement) => {
    setAnchorEl(el);
    setHighlightIndex(-1);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
    setHighlightIndex(-1);
  }, []);

  const handleClear = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setHighlightIndex(-1);
  }, []);

  const handleResultClick = useCallback(
    (type: EntityType, record: Record<string, any>) => {
      addToHistory(query);
      setHistoryVersion((v) => v + 1);
      handleClear();
      handleClose();

      switch (type) {
        case 'Opportunity':
          onOpenOpportunity(record.Id, record);
          break;
        case 'Account':
          onOpenAccount(record.Id, record);
          break;
        case 'Contact':
          onOpenContact(record.Id, record);
          break;
        case 'Task':
          onOpenTask(record.Id, record.WhatId || null, record);
          break;
      }
    },
    [query, handleClear, handleClose, onOpenOpportunity, onOpenAccount, onOpenContact, onOpenTask],
  );

  const handleViewInPipeline = useCallback(
    (type: EntityType, name: string) => {
      addToHistory(query);
      setHistoryVersion((v) => v + 1);
      handleClear();
      handleClose();
      if (mobileOpen) setMobileOpen(false);
      navigate(`/reports?tab=${TAB_NAMES[type]}&search=${encodeURIComponent(name)}`);
    },
    [query, handleClear, handleClose, mobileOpen, navigate],
  );

  const handleHistoryClick = useCallback(
    (q: string) => {
      setQuery(q);
      // Immediately trigger search
      setDebouncedQuery(q);
    },
    [],
  );

  const handleHistoryRemove = useCallback(
    (e: React.MouseEvent, q: string) => {
      e.stopPropagation();
      removeFromHistory(q);
      setHistoryVersion((v) => v + 1);
    },
    [],
  );

  const handleHistoryClear = useCallback(() => {
    clearHistory();
    setHistoryVersion((v) => v + 1);
  }, []);

  // ── Mobile auto-focus ────────────────────────────────────────────────
  useEffect(() => {
    let rafId: number | undefined;
    if (mobileOpen) {
      // Defer to next frame so the DOM has rendered the input
      rafId = requestAnimationFrame(() => inputRef.current?.focus());
    }
    return () => { if (rafId !== undefined) cancelAnimationFrame(rafId); };
  }, [mobileOpen]);

  // ── Cmd+K global listener (toggle) ──────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // If our own search input is focused, toggle closed
        if (e.target === inputRef.current) {
          e.preventDefault();
          handleClear();
          handleClose();
          inputRef.current?.blur();
          if (mobileOpen) setMobileOpen(false);
          return;
        }

        // Don't steal focus from other inputs/textareas
        const tag = (e.target as HTMLElement)?.tagName;
        const editable = (e.target as HTMLElement)?.getAttribute('contenteditable');
        if (tag === 'INPUT' || tag === 'TEXTAREA' || editable === 'true') return;
        e.preventDefault();

        if (hasOpenDialog) {
          toast('Save your work first, then ⌘K to search', {
            icon: '💾',
            duration: 3000,
          });
          return;
        }

        if (isMobile) {
          setMobileOpen((open) => !open);
        } else {
          inputRef.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hasOpenDialog, isMobile, handleClear, handleClose, mobileOpen]);

  // ── Keyboard navigation in popover ────────────────────────────────────
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClear();
        handleClose();
        inputRef.current?.blur();
        if (mobileOpen) setMobileOpen(false);
        return;
      }

      // History navigation
      if (showHistory && history.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightIndex((i) => (i + 1) % history.length);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightIndex((i) => (i <= 0 ? history.length - 1 : i - 1));
        } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < history.length) {
          e.preventDefault();
          handleHistoryClick(history[highlightIndex]);
        }
        return;
      }

      // Results navigation
      if (flatResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightIndex((i) => (i + 1) % flatResults.length);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightIndex((i) => (i <= 0 ? flatResults.length - 1 : i - 1));
        } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < flatResults.length) {
          e.preventDefault();
          const r = flatResults[highlightIndex];
          handleResultClick(r._type, r);
        }
      }
    },
    [
      showHistory, history, flatResults, highlightIndex,
      handleClear, handleClose, handleHistoryClick, handleResultClick, mobileOpen,
    ],
  );

  // Reset highlight when query changes or SOSL results arrive (not on every render).
  // Using query + soslCurrent as deps instead of displayResults to avoid resetting
  // on every render cycle (localResults reference is stable via useMemo).
  useEffect(() => {
    setHighlightIndex(-1);
  }, [query, soslCurrent, showHistory]);

  // ── Render helpers ────────────────────────────────────────────────────

  function secondaryText(type: EntityType, r: Record<string, any>): string {
    switch (type) {
      case 'Opportunity': {
        const parts: string[] = [];
        if (r.Amount != null) parts.push(formatDollar(r.Amount));
        if (r.CloseDate) parts.push(r.CloseDate);
        if (r.Owner?.Name) parts.push(r.Owner.Name);
        return parts.join(' · ');
      }
      case 'Account': {
        const parts: string[] = [];
        if (r.Type) parts.push(r.Type);
        if (r.Industry) parts.push(r.Industry);
        return parts.join(' · ');
      }
      case 'Contact': {
        const parts: string[] = [];
        if (r.Title) parts.push(r.Title);
        if (r.Account?.Name) parts.push(`@ ${r.Account.Name}`);
        else if (r.Email) parts.push(r.Email);
        return parts.join(' ');
      }
      case 'Task': {
        const parts: string[] = [];
        if (r.Status) parts.push(r.Status);
        if (r.Priority) parts.push(r.Priority);
        if (r.Who?.Name) parts.push(r.Who.Name);
        else if (r.What?.Name) parts.push(r.What.Name);
        return parts.join(' · ');
      }
      default:
        return '';
    }
  }

  function sectionCount(type: EntityType): string {
    if (!displayResults) return '0';
    const count = displayResults[type].length;
    if (isSearching) return `${count}…`;
    return String(count);
  }

  function renderSection(type: EntityType, startIndex: number) {
    if (!displayResults) return null;
    const items = displayResults[type].slice(0, MAX_PER_TYPE);
    if (items.length === 0) return null;

    return (
      <React.Fragment key={type}>
        <Typography
          variant="overline"
          role="presentation"
          sx={{ px: 2, pt: 1.5, pb: 0.5, display: 'block', color: 'text.secondary', fontWeight: 600, fontSize: '0.65rem' }}
        >
          {type === 'Opportunity' ? 'OPPORTUNITIES' : type === 'Account' ? 'ACCOUNTS' : type === 'Contact' ? 'CONTACTS' : 'TASKS'}{' '}
          ({sectionCount(type)})
        </Typography>
        {items.length > 0 ? (
          <List disablePadding>
            {items.map((r, i) => {
              const idx = startIndex + i;
              return (
                <ListItemButton
                  key={r.Id || idx}
                  role="option"
                  id={`search-result-${idx}`}
                  aria-selected={idx === highlightIndex}
                  selected={idx === highlightIndex}
                  onClick={() => handleResultClick(type, r)}
                  sx={{ px: 2, py: 0.75 }}
                >
                  <ListItemIcon sx={{ minWidth: 30 }}>
                    {type === 'Opportunity' && r.StageName ? (
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          bgcolor: getStageHexColor(r.StageName),
                          mt: 0.5,
                        }}
                      />
                    ) : (
                      ENTITY_ICONS[type]
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={r.Name || r.Subject || `${r.FirstName || ''} ${r.LastName || ''}`.trim() || 'Untitled'}
                    secondary={secondaryText(type, r)}
                    primaryTypographyProps={{ variant: 'body2', fontWeight: 500, noWrap: true }}
                    secondaryTypographyProps={{ variant: 'caption', noWrap: true }}
                    sx={{ my: 0 }}
                  />
                  <Tooltip title="View in Pipeline">
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleViewInPipeline(type, r.Name || r.Subject || '');
                      }}
                      sx={{ ml: 0.5, opacity: 0.5, '&:hover': { opacity: 1 } }}
                    >
                      <OpenInNewIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </ListItemButton>
              );
            })}
          </List>
        ) : null}
        <Divider />
      </React.Fragment>
    );
  }

  function renderHistory() {
    if (history.length === 0) {
      return (
        <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Type to search Opportunities, Accounts, Contacts, and Tasks
          </Typography>
        </Box>
      );
    }
    return (
      <>
        <Typography
          variant="overline"
          role="presentation"
          sx={{ px: 2, pt: 1.5, pb: 0.5, display: 'block', color: 'text.secondary', fontWeight: 600, fontSize: '0.65rem' }}
        >
          RECENT SEARCHES
        </Typography>
        <List disablePadding>
          {history.map((q, i) => (
            <ListItemButton
              key={q}
              role="option"
              id={`search-history-${i}`}
              aria-selected={i === highlightIndex}
              selected={i === highlightIndex}
              onClick={() => handleHistoryClick(q)}
              sx={{ px: 2, py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 30 }}>
                <HistoryIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
              </ListItemIcon>
              <ListItemText
                primary={q}
                primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                sx={{ my: 0 }}
              />
              <IconButton
                size="small"
                onClick={(e) => handleHistoryRemove(e, q)}
                sx={{ opacity: 0.3, '&:hover': { opacity: 1 } }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </ListItemButton>
          ))}
        </List>
        <Box
          sx={{ px: 2, py: 1, display: 'flex', justifyContent: 'flex-end' }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ cursor: 'pointer', '&:hover': { color: 'text.primary' } }}
            onClick={handleHistoryClear}
          >
            Clear all
          </Typography>
        </Box>
      </>
    );
  }

  function renderPopoverContent() {
    // Empty focused → show history
    if (showHistory) return renderHistory();

    // Typing < 2 chars
    if (query.length > 0 && query.length < 2) {
      return (
        <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            Type at least 2 characters
          </Typography>
        </Box>
      );
    }

    // Count total results across all entity types
    const totalCount = displayResults
      ? displayResults.Opportunity.length + displayResults.Account.length + displayResults.Contact.length + displayResults.Task.length
      : 0;

    // Error — show only when SOSL failed AND no local results to fall back on
    if (soslError && totalCount === 0) {
      return (
        <Box sx={{ p: 1 }}>
          <Alert severity="error" variant="outlined" sx={{ borderRadius: 1 }}>
            Search failed. Please try again.
          </Alert>
        </Box>
      );
    }

    // No results — only show after SOSL has been tried (isSearching is false)
    if (totalCount === 0 && !isSearching) {
      return (
        <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            No matches for &ldquo;{query}&rdquo;
          </Typography>
        </Box>
      );
    }

    // Pre-compute start indices for keyboard navigation (no mutable counter)
    const oppCount = Math.min(displayResults?.Opportunity.length ?? 0, MAX_PER_TYPE);
    const acctCount = Math.min(displayResults?.Account.length ?? 0, MAX_PER_TYPE);
    const contactCount = Math.min(displayResults?.Contact.length ?? 0, MAX_PER_TYPE);

    // Results
    return (
      <>
        {isSearching && (
          <LinearProgress
            sx={{ borderRadius: '4px 4px 0 0' }}
          />
        )}
        {renderSection('Opportunity', 0)}
        {renderSection('Account', oppCount)}
        {renderSection('Contact', oppCount + acctCount)}
        {renderSection('Task', oppCount + acctCount + contactCount)}
      </>
    );
  }

  // ── Search input (shared between desktop and mobile) ──────────────────

  const searchInput = (
    <InputBase
      inputRef={inputRef}
      placeholder="Search / Quick loads cache / Pulls all"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onFocus={(e) => handleOpen(e.currentTarget.parentElement as HTMLElement)}
      onKeyDown={handleInputKeyDown}
      size="small"
      inputProps={{
        role: 'combobox',
        'aria-expanded': popoverOpen,
        'aria-controls': 'global-search-listbox',
        'aria-haspopup': 'listbox',
        'aria-activedescendant':
          highlightIndex >= 0
            ? showHistory
              ? `search-history-${highlightIndex}`
              : `search-result-${highlightIndex}`
            : undefined,
      }}
      startAdornment={<SearchIcon sx={{ fontSize: 18, color: 'text.disabled', mr: 0.5 }} />}
      endAdornment={
        query ? (
          <IconButton size="small" onClick={handleClear} sx={{ p: 0.25 }}>
            <ClearIcon sx={{ fontSize: 16 }} />
          </IconButton>
        ) : (
          <Typography
            variant="caption"
            sx={{
              color: 'text.disabled',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 0.5,
              px: 0.5,
              fontSize: '0.6rem',
              lineHeight: 1.6,
              whiteSpace: 'nowrap',
            }}
          >
            {'⌘K'}
          </Typography>
        )
      }
      sx={{
        bgcolor: 'action.hover',
        borderRadius: 1,
        px: 1,
        py: 0.25,
        width: 340,
        fontSize: '0.85rem',
        '& .MuiInputBase-input': { py: 0.25 },
      }}
    />
  );

  // ── Desktop ───────────────────────────────────────────────────────────

  if (!isMobile) {
    return (
      <Box sx={{ mr: 1 }}>
        {searchInput}
        <Popover
          open={popoverOpen}
          anchorEl={anchorEl}
          onClose={handleClose}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          slotProps={{ paper: { sx: { width: 380, maxHeight: 560, overflowY: 'auto' } } }}
          disableAutoFocus
          disableEnforceFocus
        >
          <Box role="listbox" id="global-search-listbox">
            {renderPopoverContent()}
          </Box>
        </Popover>
      </Box>
    );
  }

  // ── Mobile ────────────────────────────────────────────────────────────

  return (
    <>
      <IconButton
        color="inherit"
        size="small"
        onClick={() => setMobileOpen(true)}
        sx={{ mr: 0.5 }}
      >
        <SearchIcon fontSize="small" />
      </IconButton>

      {mobileOpen && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: theme.zIndex.appBar + 1,
            bgcolor: 'background.paper',
            boxShadow: 3,
            p: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <Box sx={{ flex: 1 }}>{searchInput}</Box>
          <IconButton
            size="small"
            onClick={() => {
              setMobileOpen(false);
              handleClear();
              handleClose();
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      )}

      <Popover
        open={popoverOpen && mobileOpen}
        anchorEl={anchorEl}
        onClose={() => {
          handleClose();
          setMobileOpen(false);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              width: 'calc(100vw - 16px)',
              maxWidth: 380,
              maxHeight: 560,
              overflowY: 'auto',
              mt: 1,
            },
          },
        }}
        disableAutoFocus
        disableEnforceFocus
      >
        <Box role="listbox" id="global-search-listbox">
          {renderPopoverContent()}
        </Box>
      </Popover>
    </>
  );
};

export default GlobalSearch;
