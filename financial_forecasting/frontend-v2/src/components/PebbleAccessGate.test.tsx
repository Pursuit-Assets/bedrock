/**
 * Tests for PebbleAccessGate — the route-level launch-dark gate.
 *
 * Pinned behaviors:
 *   A. Loading state renders null (no flash of content).
 *   B. pebble_access=true renders children.
 *   C. pebble_access=false redirects to /dashboard.
 *   D. pebble_access missing from response → treated as false (deny).
 *   E. Non-boolean value for pebble_access → treated as false (deny).
 *
 * The strict equality check (=== true) is the load-bearing detail —
 * without it, a malformed permissions response could grant access.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { PebbleAccessGate } from "./PebbleAccessGate";

// Mock the permissions service so each test controls the data shape.
const usePermissionsMock = vi.fn();
vi.mock("@/services/permissions", () => ({
  usePermissions: () => usePermissionsMock(),
}));

function renderGate(pathname = "/pebble") {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route
          path="/pebble"
          element={
            <PebbleAccessGate>
              <div data-testid="pebble-child">Pebble content</div>
            </PebbleAccessGate>
          }
        />
        <Route path="/dashboard" element={<div data-testid="dash">Dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PebbleAccessGate", () => {
  it("renders null while permissions are loading", () => {
    usePermissionsMock.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = renderGate();
    expect(container.textContent).toBe("");
  });

  it("renders children when pebble_access is true", () => {
    usePermissionsMock.mockReturnValue({
      data: { permissions: { pebble_access: true } },
      isLoading: false,
    });
    renderGate();
    expect(screen.getByTestId("pebble-child")).toBeInTheDocument();
  });

  it("redirects to /dashboard when pebble_access is false", () => {
    usePermissionsMock.mockReturnValue({
      data: { permissions: { pebble_access: false, use_pebble_chat: true } },
      isLoading: false,
    });
    renderGate();
    expect(screen.getByTestId("dash")).toBeInTheDocument();
    expect(screen.queryByTestId("pebble-child")).not.toBeInTheDocument();
  });

  it("denies when pebble_access is missing from permissions map", () => {
    usePermissionsMock.mockReturnValue({
      data: { permissions: { use_pebble_chat: true } },
      isLoading: false,
    });
    renderGate();
    expect(screen.getByTestId("dash")).toBeInTheDocument();
    expect(screen.queryByTestId("pebble-child")).not.toBeInTheDocument();
  });

  it("denies when pebble_access has a non-boolean value (malformed response)", () => {
    usePermissionsMock.mockReturnValue({
      data: { permissions: { pebble_access: "yes" as unknown as boolean } },
      isLoading: false,
    });
    renderGate();
    expect(screen.getByTestId("dash")).toBeInTheDocument();
    expect(screen.queryByTestId("pebble-child")).not.toBeInTheDocument();
  });

  it("denies when permissions data is missing entirely", () => {
    usePermissionsMock.mockReturnValue({ data: undefined, isLoading: false });
    renderGate();
    expect(screen.getByTestId("dash")).toBeInTheDocument();
  });
});
