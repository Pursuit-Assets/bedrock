/**
 * Central registry of per-owner home pages. Each entry maps a URL slug
 * to the component that renders that owner's home.
 *
 * This file is the *only* shared file in the per-owner home flow.
 * Owners should NOT edit it as part of their work — all 9 slots are
 * pre-registered here so each owner's branch can touch only their own
 * Home<Name>.tsx file. That keeps the eventual merge conflict-free.
 *
 * Phase 2 (after each owner ships): we'll add a "redirect /home to the
 * current user's home" rule and surface a nav link.
 *
 * Each owner's home is `React.lazy`-loaded so a heavy build on one
 * person's branch (e.g., calendar + inbox + priority table on JP's)
 * does not load on any other owner's home, nor on the rest of the app.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const HomeAllie = lazy(() =>
  import("./HomeAllie").then((m) => ({ default: m.HomeAllie })),
);
const HomeAndrew = lazy(() =>
  import("./HomeAndrew").then((m) => ({ default: m.HomeAndrew })),
);
const HomeAngie = lazy(() =>
  import("./HomeAngie").then((m) => ({ default: m.HomeAngie })),
);
const HomeDevika = lazy(() =>
  import("./HomeDevika").then((m) => ({ default: m.HomeDevika })),
);
const HomeErica = lazy(() =>
  import("./HomeErica").then((m) => ({ default: m.HomeErica })),
);
const HomeGuilherme = lazy(() =>
  import("./HomeGuilherme").then((m) => ({ default: m.HomeGuilherme })),
);
const HomeJp = lazy(() =>
  import("./HomeJp").then((m) => ({ default: m.HomeJp })),
);
const HomeNick = lazy(() =>
  import("./HomeNick").then((m) => ({ default: m.HomeNick })),
);
const HomeTrent = lazy(() =>
  import("./HomeTrent").then((m) => ({ default: m.HomeTrent })),
);

export interface OwnerHome {
  slug: string;
  name: string;
  /** Email used to recognize "this is my home" on login (set later). */
  email?: string;
  component: LazyExoticComponent<ComponentType>;
}

export const OWNER_HOMES: OwnerHome[] = [
  { slug: "allie", name: "Allie", component: HomeAllie },
  { slug: "andrew", name: "Andrew", component: HomeAndrew },
  { slug: "angie", name: "Angie", component: HomeAngie },
  { slug: "devika", name: "Devika", component: HomeDevika },
  { slug: "erica", name: "Erica", component: HomeErica },
  { slug: "guilherme", name: "Guilherme", component: HomeGuilherme },
  { slug: "jp", name: "JP", component: HomeJp },
  { slug: "nick", name: "Nick", component: HomeNick },
  { slug: "trent", name: "Trent", component: HomeTrent },
];

export const OWNER_HOME_BY_SLUG: Record<string, OwnerHome> = Object.fromEntries(
  OWNER_HOMES.map((h) => [h.slug, h]),
);
