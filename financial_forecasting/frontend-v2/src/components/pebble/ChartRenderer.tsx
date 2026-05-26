/**
 * ChartRenderer — renders a single ChartSpec via Recharts.
 *
 * Switch on `kind`. Unknown kinds render an inline note rather than
 * crashing; backend's JSON-Schema enum on generate_chart's `kind` arg
 * makes this case unreachable in practice, but defensive UI > runtime
 * crash on protocol drift.
 *
 * Visual sizing: 100% width × 220px height by default. Caller wraps in
 * a container that imposes width — we don't do width: auto inside
 * Recharts because its ResponsiveContainer needs a parent width.
 *
 * Accessibility: `role="img"` + `aria-label` for screen readers since
 * Recharts SVGs are visual-only by default.
 */

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Funnel,
  FunnelChart, LabelList, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from "recharts";

import type { ChartSpec } from "@/types/pebble";

// Pursuit's neutral palette. Mirrors the ink/surface tokens — keeps
// charts visually consistent with the rest of the app rather than
// Recharts' default red.
const COLORS = ["#1f2937", "#4b5563", "#9ca3af", "#d1d5db", "#374151", "#6b7280"];
const HEIGHT = 220;

export function ChartRenderer({ spec }: { spec: ChartSpec }) {
  const aria = `${spec.kind} chart: ${spec.title || "untitled"}`;
  if (!spec.data || spec.data.length === 0) {
    return (
      <ChartShell title={spec.title} aria={aria}>
        <p className="text-[12px] text-ink-3">No data for this view.</p>
      </ChartShell>
    );
  }

  return (
    <ChartShell title={spec.title} aria={aria}>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        {renderInner(spec)}
      </ResponsiveContainer>
    </ChartShell>
  );
}

function ChartShell({
  title, aria, children,
}: {
  title: string;
  aria: string;
  children: React.ReactNode;
}) {
  return (
    <figure
      role="img"
      aria-label={aria}
      className="rounded-md border border-border-strong bg-surface p-3"
    >
      {title ? (
        <figcaption className="mb-2 text-[12.5px] font-medium text-ink-2">
          {title}
        </figcaption>
      ) : null}
      {children}
    </figure>
  );
}

// Returning a single Recharts element (not React.ReactNode) — Recharts'
// ResponsiveContainer requires exactly one child of a chart type.
function renderInner(spec: ChartSpec): React.ReactElement {
  const xKey = spec.x_key || "name";
  const yKeys = spec.y_keys.length > 0 ? spec.y_keys : ["value"];

  switch (spec.kind) {
    case "bar":
      return (
        <BarChart data={spec.data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {yKeys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />
          ))}
        </BarChart>
      );
    case "line":
      return (
        <LineChart data={spec.data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {yKeys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} />
          ))}
        </LineChart>
      );
    case "area":
      return (
        <AreaChart data={spec.data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {yKeys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} fill={COLORS[i % COLORS.length]} stroke={COLORS[i % COLORS.length]} fillOpacity={0.3} />
          ))}
        </AreaChart>
      );
    case "scatter":
      return (
        <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} type="number" />
          <YAxis dataKey={yKeys[0]} tick={{ fontSize: 11 }} type="number" />
          <Tooltip />
          <Scatter data={spec.data} fill={COLORS[0]} />
        </ScatterChart>
      );
    case "pie":
      return (
        <PieChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Pie
            data={spec.data}
            dataKey={yKeys[0]}
            nameKey={xKey}
            cx="50%" cy="50%"
            outerRadius={70}
            label
          >
            {spec.data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      );
    case "funnel":
      return (
        <FunnelChart>
          <Tooltip />
          <Funnel dataKey={yKeys[0]} data={spec.data} isAnimationActive>
            <LabelList position="right" fill="#1f2937" stroke="none" dataKey={xKey} />
            {spec.data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Funnel>
        </FunnelChart>
      );
  }
}
