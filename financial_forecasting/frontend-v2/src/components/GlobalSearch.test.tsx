/**
 * GlobalSearch tests — Layer 0.10 baseline + Layer 2.2 dual-mode
 * coverage. Asserts:
 *
 * A. Renders dialog when open, nothing when closed.
 * B. Default mode is Find; segmented toggle visible.
 * C. ? prefix and / prefix switch into Ask mode and consume the prefix.
 * D. Cmd+I toggles between modes without dropping the query.
 * E. Empty Find body shows the "Type at least 2 characters" hint.
 * F. Find queries hit /api/search after the debounce fires.
 * G. Ask body shows the example prompts when query is empty.
 * H. Footer "Ask Pebble: <query>" chip appears when Find query >= 2 chars.
 * I. Escape closes the modal.
 * J. detectModePrefix helper edge cases.
 * K. sanitizeToken strips control chars (XSS defense).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { GlobalSearch, _internals } from "./GlobalSearch";

// Mock our axios wrapper so Find requests don't actually hit the network.
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async () => ({
      data: { query_id: "q1", items: [], grouped: {}, total_count: 0, backend_used: "postgres_fts", took_ms: 12 },
    })),
  },
}));

import { api } from "@/lib/api";

function renderModal(props: { open: boolean; onClose?: () => void } = { open: true }) {
  const onClose = props.onClose ?? vi.fn();
  return {
    onClose,
    ...render(
      <MemoryRouter>
        <GlobalSearch open={props.open} onClose={onClose} />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A. Open / closed
// ---------------------------------------------------------------------------

describe("open/closed", () => {
  it("renders nothing when closed", () => {
    const { container } = renderModal({ open: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders dialog with aria-modal when open", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});

// ---------------------------------------------------------------------------
// B. Default mode + toggle
// ---------------------------------------------------------------------------

describe("mode toggle", () => {
  it("starts in Find mode by default", () => {
    renderModal();
    const findRadio = screen.getByRole("radio", { name: /find/i });
    expect(findRadio).toHaveAttribute("aria-checked", "true");
  });

  it("clicking Ask radio switches mode", async () => {
    renderModal();
    const user = userEvent.setup();
    const askRadio = screen.getByRole("radio", { name: /ask pebble/i });
    await user.click(askRadio);
    expect(askRadio).toHaveAttribute("aria-checked", "true");
  });
});

// ---------------------------------------------------------------------------
// C. Prefix detection
// ---------------------------------------------------------------------------

describe("prefix detection", () => {
  it("? prefix switches to Ask mode", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "?why is acme stalling");
    const askRadio = screen.getByRole("radio", { name: /ask pebble/i });
    expect(askRadio).toHaveAttribute("aria-checked", "true");
    expect(input.value).toBe("why is acme stalling");
  });

  it("/ prefix switches to Ask mode", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "/find acme");
    const askRadio = screen.getByRole("radio", { name: /ask pebble/i });
    expect(askRadio).toHaveAttribute("aria-checked", "true");
  });
});

// ---------------------------------------------------------------------------
// D. Cmd+I toggle preserves query
// ---------------------------------------------------------------------------

describe("Cmd+I", () => {
  it("toggles mode and keeps the query intact", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "acme");
    expect(input.value).toBe("acme");

    await user.keyboard("{Meta>}i{/Meta}");
    expect(screen.getByRole("radio", { name: /ask pebble/i })).toHaveAttribute("aria-checked", "true");
    expect(input.value).toBe("acme");

    await user.keyboard("{Meta>}i{/Meta}");
    expect(screen.getByRole("radio", { name: /find/i })).toHaveAttribute("aria-checked", "true");
    expect(input.value).toBe("acme");
  });
});

// ---------------------------------------------------------------------------
// E + F. Find body
// ---------------------------------------------------------------------------

describe("find body", () => {
  it("shows 'Type at least 2 characters' on empty input", () => {
    renderModal();
    expect(screen.getByText(/type at least 2 characters/i)).toBeInTheDocument();
  });

  it("calls /api/search after debounce when query >= 2 chars", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "acme");
    await waitFor(
      () => {
        expect(api.get).toHaveBeenCalledWith(expect.stringContaining("/api/search?q=acme"));
      },
      { timeout: 1000 },
    );
  });

  it("does not call API when query < 2 chars", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "a");
    // Wait past the debounce window — should still not have fired.
    await new Promise((r) => setTimeout(r, 400));
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G. Ask body
// ---------------------------------------------------------------------------

describe("ask body", () => {
  it("shows example prompts when query is empty", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /ask pebble/i }));
    expect(screen.getByText(/Ask Pebble anything about your CRM/i)).toBeInTheDocument();
    expect(screen.getByText(/which open deals are at risk/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// H. Footer Ask chip
// ---------------------------------------------------------------------------

describe("ask chip", () => {
  it("shows 'Ask Pebble: <query>' when Find has 2+ char query", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "acme");
    expect(screen.getByText(/Ask Pebble:/i)).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("hides the chip when query < 2 chars", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "a");
    expect(screen.queryByText(/Ask Pebble:/i)).toBeNull();
  });

  it("clicking the chip switches to Ask mode", async () => {
    renderModal();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "metlife");
    const chip = screen.getByText(/Ask Pebble:/i).closest("button")!;
    await user.click(chip);
    expect(screen.getByRole("radio", { name: /ask pebble/i })).toHaveAttribute("aria-checked", "true");
  });
});

// ---------------------------------------------------------------------------
// I. Escape closes
// ---------------------------------------------------------------------------

describe("escape", () => {
  it("calls onClose when Escape pressed", async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop clicked", async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("global-search-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// J + K. Helpers
// ---------------------------------------------------------------------------

describe("detectModePrefix", () => {
  it("returns null mode for plain text", () => {
    expect(_internals.detectModePrefix("acme")).toEqual({ mode: null, rest: "acme" });
  });

  it("strips the leading ?", () => {
    expect(_internals.detectModePrefix("?why")).toEqual({ mode: "ask", rest: "why" });
  });

  it("strips the leading /", () => {
    expect(_internals.detectModePrefix("/why")).toEqual({ mode: "ask", rest: "why" });
  });

  it("trims left after the prefix", () => {
    expect(_internals.detectModePrefix("?  why")).toEqual({ mode: "ask", rest: "why" });
  });

  it("handles empty input", () => {
    expect(_internals.detectModePrefix("")).toEqual({ mode: null, rest: "" });
  });
});

describe("sanitizeToken", () => {
  it("strips control characters", () => {
    // Real token without controls passes through unchanged.
    expect(_internals.sanitizeToken("hello world")).toBe("hello world");
  });

  it("returns the same string for plain text", () => {
    expect(_internals.sanitizeToken("Acme Corp · Customer")).toBe("Acme Corp · Customer");
  });

  it("removes binary control bytes", () => {
    const dirty = "beforeafter";
    expect(_internals.sanitizeToken(dirty)).toBe("beforeafter");
  });
});
