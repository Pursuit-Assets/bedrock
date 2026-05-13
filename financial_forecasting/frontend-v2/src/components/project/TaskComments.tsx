import { useMemo, useRef, useState } from "react";
import { Loader2, MoreHorizontal, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { useCurrentUser } from "@/services/auth";
import { useActiveUsers } from "@/services/projects";
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment,
  type Comment,
} from "@/services/comments";

const AVATAR_COLORS = [
  "bg-blue-400",
  "bg-purple-400",
  "bg-green-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-cyan-400",
] as const;

function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) ?? 0) % AVATAR_COLORS.length];
}

interface TaskCommentsProps {
  taskId: string;
}

/** Comment thread + composer for a project task. Backed by
 *  public.org_comments via /api/comments/project_task/{id}. */
export function TaskComments({ taskId }: TaskCommentsProps) {
  const { data: comments = [], isLoading } = useComments("project_task", taskId);
  const createComment = useCreateComment("project_task", taskId);

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
        Comments {comments.length > 0 ? `(${comments.length})` : null}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          Loading…
        </div>
      ) : comments.length === 0 ? (
        <p className="mb-3 text-[12px] text-ink-4">No comments yet.</p>
      ) : (
        <ul className="mb-3 space-y-3">
          {comments.map((c) => (
            <CommentItem key={c.id} comment={c} taskId={taskId} />
          ))}
        </ul>
      )}

      <CommentComposer
        onSubmit={async (content) => {
          await createComment.mutateAsync(content);
        }}
        submitting={createComment.isPending}
      />
    </div>
  );
}

interface CommentComposerProps {
  initial?: string;
  onSubmit: (content: string) => Promise<void>;
  onCancel?: () => void;
  submitting?: boolean;
  placeholder?: string;
  compact?: boolean;
}

/** Textarea + send button. @-typing triggers a user picker; arrows + Enter
 *  pick a user; the @Name token is inserted into the textarea. */
function CommentComposer({
  initial = "",
  onSubmit,
  onCancel,
  submitting,
  placeholder = "Add a comment… type @ to mention",
  compact,
}: CommentComposerProps) {
  const [value, setValue] = useState(initial);
  const [mentionState, setMentionState] = useState<{
    open: boolean;
    query: string;
    /** Index in the textarea where the '@' lives. */
    start: number;
    activeIdx: number;
  }>({ open: false, query: "", start: -1, activeIdx: 0 });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { data: users = [] } = useActiveUsers();

  const filtered = useMemo(() => {
    if (!mentionState.open) return [];
    const ql = mentionState.query.toLowerCase();
    return users
      .filter((u) => {
        if (!ql) return true;
        return (
          (u.display_name ?? "").toLowerCase().includes(ql) ||
          (u.email ?? "").toLowerCase().includes(ql)
        );
      })
      .slice(0, 6);
  }, [users, mentionState.open, mentionState.query]);

  function recomputeMention(text: string, caret: number) {
    // Walk back from caret until we hit whitespace or '@'.
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        // Confirm '@' is at start or preceded by whitespace.
        if (i === 0 || /\s/.test(text[i - 1])) {
          const query = text.slice(i + 1, caret);
          // Limit query to single word — abort mention if user typed a newline.
          if (!/\s/.test(query)) {
            setMentionState({ open: true, query, start: i, activeIdx: 0 });
            return;
          }
        }
        break;
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    setMentionState((s) => (s.open ? { ...s, open: false } : s));
  }

  function pickUser(idx: number) {
    const u = filtered[idx];
    if (!u || mentionState.start < 0) return;
    const ta = taRef.current;
    if (!ta) return;
    const before = value.slice(0, mentionState.start);
    const after = value.slice(ta.selectionStart);
    const name = u.display_name || u.email || "";
    const insert = `@${name} `;
    const next = before + insert + after;
    setValue(next);
    setMentionState({ open: false, query: "", start: -1, activeIdx: 0 });
    // Restore caret position after the inserted mention.
    queueMicrotask(() => {
      const pos = (before + insert).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function commit() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    await onSubmit(trimmed);
    setValue("");
  }

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          recomputeMention(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mentionState.open && filtered.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionState((s) => ({
                ...s,
                activeIdx: (s.activeIdx + 1) % filtered.length,
              }));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionState((s) => ({
                ...s,
                activeIdx: (s.activeIdx - 1 + filtered.length) % filtered.length,
              }));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pickUser(mentionState.activeIdx);
              return;
            }
            if (e.key === "Escape") {
              setMentionState({ open: false, query: "", start: -1, activeIdx: 0 });
              return;
            }
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape" && onCancel) {
            onCancel();
          }
        }}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
      />
      <div className="mt-1 flex items-center justify-between text-[10.5px] text-ink-4">
        <span>Cmd/Ctrl+Enter to {onCancel ? "save" : "send"}</span>
        <div className="flex items-center gap-1.5">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-2 py-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!value.trim() || submitting}
            className="inline-flex items-center gap-1 rounded bg-ink px-2 py-0.5 text-[11px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Send size={11} />
            )}
            {onCancel ? "Save" : "Send"}
          </button>
        </div>
      </div>

      {mentionState.open && filtered.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border-strong bg-surface shadow-lg">
          {filtered.map((u, idx) => {
            const active = idx === mentionState.activeIdx;
            return (
              <button
                key={u.id}
                type="button"
                onMouseDown={(e) => {
                  // Prevent textarea blur before we mutate state.
                  e.preventDefault();
                  pickUser(idx);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2",
                  active && "bg-surface-2",
                )}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                    avatarColor(u.display_name || u.email || "?"),
                  )}
                >
                  {initials(u.display_name || u.email || "?")}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {u.display_name || u.email}
                </span>
                {u.display_name && u.email ? (
                  <span className="truncate text-[10.5px] text-ink-4">
                    {u.email}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Single comment row with author header, body (mentions highlighted),
 *  and hover-revealed edit/delete for the author. */
function CommentItem({
  comment,
  taskId,
}: {
  comment: Comment;
  taskId: string;
}) {
  const { data: me } = useCurrentUser();
  const updateComment = useUpdateComment("project_task", taskId);
  const deleteComment = useDeleteComment("project_task", taskId);
  const [editing, setEditing] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const isAuthor =
    !!comment.author?.email && !!me?.email && comment.author.email === me.email;
  const name = comment.author?.display_name || comment.author?.email || "Unknown";
  const when = comment.created_at
    ? formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })
    : "";
  const edited =
    comment.updated_at &&
    comment.created_at &&
    comment.updated_at !== comment.created_at;

  if (editing) {
    return (
      <li className="rounded border border-border bg-surface-2/40 p-2">
        <CommentComposer
          initial={comment.content}
          compact
          onSubmit={async (content) => {
            await updateComment.mutateAsync({ commentId: comment.id, content });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          submitting={updateComment.isPending}
        />
      </li>
    );
  }

  return (
    <li className="group/comment flex gap-2">
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
          avatarColor(name),
        )}
        title={name}
      >
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1 rounded border border-border bg-surface px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-ink">{name}</span>
          <span className="text-ink-4">·</span>
          <span className="text-ink-3">{when}</span>
          {edited ? <span className="text-ink-4">(edited)</span> : null}
          {isAuthor ? (
            <div className="relative ml-auto">
              <button
                type="button"
                onClick={() => setActionsOpen((o) => !o)}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-4 opacity-0 group-hover/comment:opacity-100 hover:bg-surface-2 hover:text-ink"
                aria-label="Comment actions"
              >
                <MoreHorizontal size={12} />
              </button>
              {actionsOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-md border border-border-strong bg-surface shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(true);
                      setActionsOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("Delete this comment?")) {
                        deleteComment.mutate(comment.id);
                      }
                      setActionsOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-surface-2"
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-ink-2">
          {renderMentions(comment.content)}
        </p>
      </div>
    </li>
  );
}

/** Plain-text renderer that highlights @mentions with accent color.
 *  Matches the factory pattern. */
function renderMentions(text: string): React.ReactNode {
  const parts = text.split(/(@[\w][\w\s'-]*?(?=\s|$|[,.;:!?]))/g);
  return parts.map((part, idx) => {
    if (part.startsWith("@")) {
      return (
        <span key={idx} className="font-medium text-accent">
          {part}
        </span>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

