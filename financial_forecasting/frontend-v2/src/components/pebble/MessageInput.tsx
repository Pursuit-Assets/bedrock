/**
 * MessageInput — multi-line textarea + send button + streaming-state
 * cancel button.
 *
 * Behaviors:
 *   - Enter sends; Shift+Enter inserts newline.
 *   - Cmd/Ctrl+Enter also sends (matches the "Slack convention").
 *   - Send disabled when query empty or while streaming (unless caller
 *     wires up streaming-time send for parallel turns; we don't in v1).
 *   - Cancel button visible when streaming; aborts the active turn.
 *   - Auto-grows up to ~6 lines, then scrolls.
 */

import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";

import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isStreaming: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export function MessageInput({
  value, onChange, onSubmit, onCancel, isStreaming,
  placeholder = "Ask Pebble anything…",
  disabled = false,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow logic — adjust rows based on content height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 6 * 22 /* px per row */ + 16);
    ta.style.height = `${next}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !disabled && !isStreaming;

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSend) onSubmit();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <div className="flex items-end gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2 focus-within:border-ink-3 focus-within:shadow-sm">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
        aria-label="Pebble query"
        className={cn(
          "min-h-[22px] flex-1 resize-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-ink-4",
          disabled && "opacity-60",
        )}
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onCancel}
          aria-label="Stop generating"
          title="Stop"
          className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md bg-ink-2 text-surface hover:bg-ink"
        >
          <Square size={11} fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send message"
          title="Send (Enter)"
          className={cn(
            "grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-surface",
            canSend ? "bg-ink hover:opacity-90" : "bg-ink-4 cursor-not-allowed",
          )}
        >
          <ArrowUp size={13} />
        </button>
      )}
    </div>
  );
}
