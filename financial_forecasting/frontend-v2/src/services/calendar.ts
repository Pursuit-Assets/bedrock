import { useQuery } from "@tanstack/react-query";

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

async function fetchMyEvents(opts: FetchOpts): Promise<GCalEvent[]> {
  const params = new URLSearchParams();
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.calendarId) params.set("calendar_id", opts.calendarId);
  try {
    const qs = params.toString();
    const { data } = await api.get<CalendarResponse | GCalEvent[]>(
      qs ? `/api/calendar/my-events?${qs}` : "/api/calendar/my-events",
    );
    if (Array.isArray(data)) return data;
    return data?.data ?? [];
  } catch {
    // Calendar not connected / token expired — degrade gracefully so the
    // home page still renders without a banner storm in the console.
    return [];
  }
}

/**
 * Fetch GCal events within an inclusive date window. Returns `[]` when
 * the user hasn't connected Google (or the backend errors); UI should
 * still render but show its empty state.
 */
export function useMyCalendarEvents(opts: FetchOpts) {
  return useQuery({
    queryKey: ["calendar-my-events", opts.start, opts.end, opts.limit, opts.calendarId],
    queryFn: () => fetchMyEvents(opts),
    staleTime: 60_000,
    retry: false,
  });
}
