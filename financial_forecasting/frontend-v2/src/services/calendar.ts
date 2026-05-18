import { useQuery } from "@tanstack/react-query";
import axios from "axios";

import { api } from "@/lib/api";

/**
 * Single Google Calendar event from `GET /api/calendar/my-events`.
 * Mirrors the shape produced by `main.py:2598–2613`.
 */
export interface GCalEvent {
  id: string;
  summary: string;
  start: string;
  end?: string;
  attendees?: Array<{ name?: string; email?: string; status?: string }>;
  location?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
}

interface CalendarResponse {
  data?: GCalEvent[];
  total?: number;
}

interface FetchOpts {
  /** ISO date YYYY-MM-DD (inclusive). */
  start?: string;
  /** ISO date YYYY-MM-DD (inclusive). */
  end?: string;
  /** Default 100; the backend caps at 200. */
  limit?: number;
  /**
   * Optional calendar id. When omitted, the backend uses the env-
   * configured PBD shared calendar. The backend rejects ids other than
   * the PBD one, so callers should only pass a value if they know it
   * matches `PBD_CALENDAR_ID`.
   */
  calendarId?: string;
}

export interface CalendarFetchError extends Error {
  /** True when the failure looks like a stale / missing Google OAuth token. */
  needsReauth: boolean;
  /** HTTP status if the failure was an HTTP response. */
  status?: number;
}

async function fetchMyEvents(opts: FetchOpts): Promise<GCalEvent[]> {
  const params = new URLSearchParams();
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.calendarId) params.set("calendar_id", opts.calendarId);
  const qs = params.toString();
  try {
    const { data } = await api.get<CalendarResponse | GCalEvent[]>(
      qs ? `/api/calendar/my-events?${qs}` : "/api/calendar/my-events",
    );
    if (Array.isArray(data)) return data;
    return data?.data ?? [];
  } catch (e) {
    // Surface auth / Google-token failures so the UI can show a
    // "reconnect Google" affordance. Other failures (5xx, network)
    // degrade silently — the calendar pane shows its empty state.
    if (axios.isAxiosError(e)) {
      const status = e.response?.status;
      const detail =
        (e.response?.data as { detail?: string } | undefined)?.detail ?? "";
      const looksAuth =
        status === 401 ||
        status === 403 ||
        /token|reauth|google|unauthorized|invalid_grant/i.test(detail);
      if (looksAuth) {
        const err: CalendarFetchError = Object.assign(
          new Error("Google calendar reauth required"),
          { needsReauth: true, status },
        );
        throw err;
      }
    }
    return [];
  }
}

/**
 * Fetch GCal events within an inclusive date window. Returns `[]` when
 * the user hasn't connected Google (or the backend errors); UI should
 * still render but show its empty state.
 */
export function useMyCalendarEvents(opts: FetchOpts) {
  return useQuery<GCalEvent[], CalendarFetchError>({
    queryKey: ["calendar-my-events", opts.start, opts.end, opts.limit, opts.calendarId],
    queryFn: () => fetchMyEvents(opts),
    staleTime: 60_000,
    retry: false,
  });
}
