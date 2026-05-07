import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// frontend-v2 test config. Layer 0.10 of the Pebble 1.0 plan —
// baseline test infrastructure. Phase B / C UI surface area must
// not ship without tests once this is in place.
//
// Notes:
//   * jsdom for DOM simulation; node would be faster but
//     React 19 + @testing-library needs a window.
//   * css: false skips processing of the Tailwind/PostCSS pipeline
//     during tests — we don't assert on computed styles, and skipping
//     it makes the test run noticeably faster.
//   * Coverage thresholds enforced on changed files. Currently
//     advisory; CI gate flips when initial test corpus lands.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/components/**", "src/pages/**", "src/lib/**", "src/services/**"],
      exclude: ["**/*.test.*", "**/*.spec.*", "src/test/**"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
