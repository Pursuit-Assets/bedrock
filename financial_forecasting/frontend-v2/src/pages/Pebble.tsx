/**
 * Pebble — single-conversation page surface.
 *
 * Layout (3-column scaffold; sidebar slot empty in L1):
 *
 *   ┌─────────────┬───────────────────────────────────┬─────────┐
 *   │  History    │   ConversationView                │  empty  │
 *   │  (slot,     │   (turns, plan-as-todos,          │  for L1 │
 *   │   empty L1) │    streaming text, charts,        │         │
 *   │             │    citations)                     │         │
 *   │             │                                   │         │
 *   │             ├───────────────────────────────────┤         │
 *   │             │   MessageInput (sticky bottom)    │         │
 *   └─────────────┴───────────────────────────────────┴─────────┘
 *
 * URL parameter: ``?conv=<uuid>`` — ties the page to a specific
 * conversation id so links from GlobalSearch's "Continue in Pebble"
 * CTA hydrate the right state. When absent, mints a fresh
 * conversation on mount.
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Sparkles } from "lucide-react";

import { PebbleConversationProvider, usePebbleConversation } from
  "@/context/PebbleConversationContext";
import { ConversationView } from "@/components/pebble/ConversationView";
import { MessageInput } from "@/components/pebble/MessageInput";

const SIDEBAR_WIDTH = 240;

export function PebblePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationId = searchParams.get("conv") || undefined;

  // The provider keys off the URL param. When user clicks "New
  // conversation", we navigate to /pebble (no ?conv) which causes
  // a remount with a fresh provider.
  return (
    <PebbleConversationProvider conversationId={conversationId}>
      <PebblePageInner onUrlSync={(id) => {
        // Sync the actual conversation_id back into the URL so the
        // user can copy-paste / share / refresh and get the same state.
        if (!searchParams.get("conv")) {
          setSearchParams({ conv: id }, { replace: true });
        }
      }} />
    </PebbleConversationProvider>
  );
}

function PebblePageInner({
  onUrlSync,
}: {
  onUrlSync: (conversationId: string) => void;
}) {
  const conv = usePebbleConversation();
  const [draft, setDraft] = useState("");
  const navigate = useNavigate();

  // Sync URL with the provider's conversation_id once at mount.
  useEffect(() => {
    onUrlSync(conv.conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.conversationId]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void conv.sendQuery(text);
  }, [draft, conv]);

  const startNew = useCallback(() => {
    conv.cancel();
    // Drop the ?conv param so a fresh provider gets a fresh id.
    navigate("/pebble");
  }, [conv, navigate]);

  return (
    <div
      className="grid h-full overflow-hidden"
      style={{ gridTemplateColumns: `${SIDEBAR_WIDTH}px 1fr` }}
    >
      <Sidebar onStartNew={startNew} />
      <main className="flex h-full flex-col overflow-hidden">
        <Header />
        <ConversationView turns={conv.turns} isStreaming={conv.isStreaming} />
        <div className="border-t border-border-strong bg-surface-2 px-6 py-3">
          <div className="mx-auto max-w-[800px]">
            <MessageInput
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              onCancel={conv.cancel}
              isStreaming={conv.isStreaming}
              placeholder="Ask Pebble anything…  (try /pipeline)"
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="flex items-center gap-2 border-b border-border-strong bg-surface px-6 py-3">
      <Sparkles size={15} className="text-ink-3" aria-hidden="true" />
      <h1 className="text-[14px] font-semibold text-ink">Ask Pebble</h1>
    </header>
  );
}

function Sidebar({ onStartNew }: { onStartNew: () => void }) {
  // L1 ships the sidebar slot empty (no conversation history).
  // Layered later: GET /api/v1/chat/history → list of recent
  // conversations with click-to-resume. For now, the slot is just a
  // "New conversation" button + branding.
  return (
    <aside
      aria-label="Pebble navigation"
      className="flex flex-col gap-3 border-r border-border-strong bg-surface-2 p-3"
    >
      <button
        type="button"
        onClick={onStartNew}
        className="flex h-8 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink"
      >
        <Plus size={13} className="opacity-70" aria-hidden="true" />
        New conversation
      </button>
      {/* History list slot — empty in L1.
          Future: <PebbleHistoryList /> */}
    </aside>
  );
}
