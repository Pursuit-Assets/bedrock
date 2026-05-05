export function Placeholder({ name }: { name: string }) {
  return (
    <div className="rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
      <div className="mb-1 text-base font-semibold text-ink">{name}</div>
      <div>This page is scaffolded but not yet implemented.</div>
      <div className="mt-2 text-[11.5px] text-ink-4">
        See <span className="mono">tasks/bedrock-redesign-data-model.md</span>{" "}
        for context · UI build plan coming next.
      </div>
    </div>
  );
}
