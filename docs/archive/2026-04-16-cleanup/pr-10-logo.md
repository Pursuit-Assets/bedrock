# PR 10: Logo Redesign

**Type:** Design / Cosmetic
**Size:** Small
**Branch:** `feature/logo-redesign`
**Depends on:** Nothing

## Problem

Current logo uses MUI's `HolidayVillage` icon, which is generic and doesn't convey the Bedrock brand. The logo should look like a mountain with a city built on top of it.

## Current State

In `src/components/Layout.tsx`:
- Sidebar uses `HolidayVillage` icon (aliased as `BedrockIcon`)
- Text label "Bedrock" next to it
- No favicon or logo images in `public/` (referenced in index.html but missing)
- `manifest.json` still says "Revenue Hub"

## Design Brief

**Concept:** A mountain silhouette with a city/skyline built on its peak.

**Requirements:**
- Simple enough to work at 24px (sidebar icon) and 192px (PWA icon)
- Single-color version for the sidebar (adapts to theme)
- Full-color version for favicon and PWA manifest
- Should feel modern, architectural, aspirational
- Must be an SVG for scalability

**Style direction:**
- Clean geometric lines (not illustrative/detailed)
- Mountain as a strong triangular base
- 3-5 building silhouettes rising from the peak
- Optionally: subtle horizontal lines suggesting bedrock layers

## Deliverables

1. **SVG component** — React component replacing `HolidayVillage` in Layout.tsx
2. **favicon.ico** — 16x16 and 32x32 versions
3. **logo192.png** — 192x192 for PWA manifest
4. **logo512.png** — 512x512 for PWA manifest (optional)

## Files to Touch

- `financial_forecasting/frontend/src/components/Layout.tsx` — replace icon
- `financial_forecasting/frontend/src/components/BedrockLogo.tsx` — **new file** (SVG component)
- `financial_forecasting/frontend/public/favicon.ico` — **new file**
- `financial_forecasting/frontend/public/logo192.png` — **new file**
- `financial_forecasting/frontend/public/manifest.json` — update name and icons

## Acceptance Criteria

- [ ] Custom mountain+city SVG replaces HolidayVillage in sidebar
- [ ] Icon is crisp at 24px sidebar size
- [ ] Favicon displays in browser tab
- [ ] manifest.json references correct icon files
- [ ] manifest.json name updated from "Revenue Hub" to "Bedrock"
