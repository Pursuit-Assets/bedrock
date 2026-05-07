/**
 * Vitest test setup. Imported by every test file via vitest.config.ts
 * setupFiles. Add globals + DOM polyfills here.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Auto-cleanup after each test — drops mounted React trees so they
// don't leak between tests.
afterEach(() => {
  cleanup();
});

// IntersectionObserver polyfill — jsdom doesn't provide one, and
// several Radix primitives (Dialog, Popover) probe for it on mount.
if (typeof globalThis.IntersectionObserver === "undefined") {
  // @ts-expect-error — jsdom polyfill, not a full implementation.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

// matchMedia polyfill — Tailwind's `dark:` variants and a few
// component prefs read it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Quiet down React act() warnings emitted by libraries that haven't
// migrated to React 19's act-from-react. Re-enable selectively if a
// real act warning slips through.
const _origError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("act(") || msg.includes("not wrapped in act")) return;
  _origError.apply(console, args as Parameters<typeof console.error>);
};
