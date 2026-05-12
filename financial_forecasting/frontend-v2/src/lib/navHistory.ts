/**
 * In-app navigation tracker + scroll position cache.
 *
 * - recordNavigation(): called from AppShell on every route change
 * - hasInAppHistory(): true if navigate(-1) is safe
 * - saveScroll(key, pos): save scroll position before navigating away
 * - restoreScroll(key): retrieve saved position on back nav
 */
let _count = 0;
const _scrollCache = new Map<string, number>();

export function recordNavigation(): void {
  _count++;
}

export function hasInAppHistory(): boolean {
  return _count > 0;
}

export function saveScroll(key: string, position: number): void {
  _scrollCache.set(key, position);
}

export function restoreScroll(key: string): number | null {
  const pos = _scrollCache.get(key) ?? null;
  // Don't delete — user might navigate back multiple times
  return pos;
}
