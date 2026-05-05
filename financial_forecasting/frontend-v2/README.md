# Bedrock Frontend v2

Parallel React 19 + Vite + Tailwind + shadcn-style mount alongside the
existing CRA frontend at `../frontend/`. Built to deliver the Bedrock
redesign (Linear/Attio aesthetic) without disrupting the legacy app.

See:

- `tasks/bedrock-redesign-data-model.md` — backend / model plan (Awards
  entity, task routing, etc.).
- `bedrock-mockup/project/Bedrock.html` (in the design bundle) — visual
  reference. Tokens in `tailwind.config.ts` + `src/index.css` mirror the
  mockup's CSS custom properties.

## Run

```bash
cd financial_forecasting/frontend-v2
npm install
npm run dev          # → http://localhost:4200
```

The Vite dev server proxies `/api/*` to `http://localhost:8000` (the
FastAPI backend). Override with `VITE_API_URL=...`.

The legacy CRA frontend continues to run on :3000 via
`cd ../frontend && npm start`.

## Layout

```
frontend-v2/
├── src/
│   ├── main.tsx              React Query + Router boot
│   ├── App.tsx               7-route map matching the design's nav
│   ├── components/
│   │   ├── AppShell.tsx      Sidebar + topbar layout
│   │   ├── PageHeader.tsx    Consistent page header primitive
│   │   └── Placeholder.tsx   "Not yet implemented" stub
│   ├── pages/                One file per top-level route — Dashboard,
│   │                         Accounts, Pipeline, Awards, Projects,
│   │                         Tasks, Contacts (all stubbed today)
│   ├── lib/
│   │   ├── api.ts            Axios instance + Bearer auth interceptor
│   │   └── utils.ts          `cn()` helper (clsx + tailwind-merge)
│   └── index.css             Tailwind base + Bedrock CSS tokens
├── tailwind.config.ts        Bedrock palette + shadcn aliases
├── vite.config.ts            Port 4200, /api proxy to :8000
└── package.json
```

## Theme

The Tailwind theme is driven by CSS custom properties in `src/index.css`
that match the mockup exactly. To tweak the palette, edit those vars —
the Tailwind config consumes them via `var(--token)` references.

The `mono` class swaps to JetBrains Mono for numerics and IDs (per the
mockup convention).

## Status

Scaffold only. All seven pages are stubbed. The next phase implements:

1. Accounts list (over `/api/salesforce/accounts`).
2. Pipeline list/kanban/funnel views (over `/api/opportunities`).
3. Awards list + detail (over `/api/awards`).
4. The other four pages, in priority order TBD.
