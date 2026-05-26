/**
 * Collapsible description editor used at workstream / milestone / task
 * level on the ProjectDetail page.
 *
 * Resting states:
 *   - has value, ≤ 120 chars: render inline.
 *   - has value, > 120 chars: render truncated with "Show more" toggle.
 *   - empty + canEdit: render a subtle "+ Add description" link.
 *   - empty + !canEdit: render nothing.
 *
 * Editing:
 *   - Click into resting state → textarea grows in place.
 *   - Save: blur OR Ctrl/Cmd+Enter.
 *   - Cancel: Esc (reverts the draft to the original value).
 *
 * Mirrors the optimistic update + saving spinner from `InlineText` so
 * the visual language stays consistent across the app.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const PREVIEW_CHARS = 120;

interface DescriptionEditorProps {
  value: string | null | undefined;
  onSave: (next: string) => Promise<void> | void;
  canEdit?: boolean;
  /** Label for the empty-state add affordance. Defaults to "Add description". */
  placeholder?: string;
  /** Smaller indentation/spacing — used inside dense task rows. */
  compact?: boolean;
  className?: string;
}

export function DescriptionEditor({
  value,
  onSave,
  canEdit = true,
  placeholder = "Add description",
  compact = false,
  className,
}: DescriptionEditorProps) {
  const raw = (value ?? "").trim();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(raw);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep local draft in sync with incoming changes. Drop the optimistic
  // shadow once the server-side value matches it.
  useEffect(() => {
    setDraft(raw);
    setOptimistic((prev) => (prev != null && prev === raw ? null : prev));
  }, [raw]);

  // Focus the textarea on enter-edit + auto-grow to content.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      // Move caret to end so users can append rather than overwrite.
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
      autosize(textareaRef.current);
    }
  }, [editing]);

  const display = optimistic ?? raw;
  const hasValue = display.length > 0;

  // Resting empty state — show "+ Add description" only when editable.
  if (!editing && !hasValue) {
    if (!canEdit) return null;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          "block text-left text-[11.5px] italic text-ink-4 hover:text-ink-3",
          compact ? "px-1 py-0.5" : "px-1.5 py-1",
          className,
        )}
      >
        + {placeholder}
      </button>
    );
  }

  if (editing) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autosize(e.currentTarget);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(raw);
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? 2 : 3}
          className={cn(
            "w-full resize-none rounded border border-accent bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4",
            compact && "text-[12px]",
          )}
        />
        <div className="text-[10.5px] text-ink-4">
          Cmd/Ctrl+Enter to save, Esc to cancel
        </div>
      </div>
    );
  }

  // Resting non-empty state — truncated when long, expandable.
  const needsTruncation = display.length > PREVIEW_CHARS;
  const shown = needsTruncation && !expanded
    ? display.slice(0, PREVIEW_CHARS).trimEnd() + "…"
    : display;

  async function commit() {
    if (saving) return;
    const next = draft.trim();
    if (next === raw) {
      setEditing(false);
      return;
    }
    setOptimistic(next);
    setEditing(false);
    setSaving(true);
    try {
      await onSave(next);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
    } catch (err) {
      setOptimistic(null);
      // surface a console error rather than blocking with an alert
      console.error("DescriptionEditor save failed", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("group/desc flex items-start gap-1.5", className)}>
      <button
        type="button"
        onClick={() => canEdit && setEditing(true)}
        disabled={!canEdit}
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words text-left text-[12.5px] leading-relaxed text-ink-2",
          canEdit && "rounded hover:bg-surface hover:ring-1 hover:ring-border-strong",
          compact ? "px-1 py-0.5 text-[12px]" : "px-1.5 py-1",
        )}
      >
        {shown}
        {needsTruncation ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="ml-1 text-[11px] text-ink-3 underline-offset-2 hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </span>
        ) : null}
      </button>
      <span className="mt-1 flex-shrink-0 text-ink-4">
        {saving ? (
          <Loader2 size={11} className="animate-spin" />
        ) : savedFlash ? (
          <Check size={11} className="text-green" />
        ) : null}
      </span>
    </div>
  );
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}
