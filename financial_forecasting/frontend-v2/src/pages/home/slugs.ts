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
 */
import type { ComponentType } from "react";

import { HomeAllie } from "./HomeAllie";
import { HomeAndrew } from "./HomeAndrew";
import { HomeAngie } from "./HomeAngie";
import { HomeDevika } from "./HomeDevika";
import { HomeErica } from "./HomeErica";
import { HomeGuilherme } from "./HomeGuilherme";
import { HomeJp } from "./HomeJp";
import { HomeNick } from "./HomeNick";
import { HomeTrent } from "./HomeTrent";

export interface OwnerHome {
  slug: string;
  name: string;
  /** Email used to recognize "this is my home" on login (set later). */
  email?: string;
  component: ComponentType;
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
