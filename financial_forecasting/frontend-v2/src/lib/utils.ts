import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind classes safely — used by every shadcn-style primitive.
 * Last write wins on conflicts (e.g. `cn("px-2", "px-4")` → `"px-4"`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
