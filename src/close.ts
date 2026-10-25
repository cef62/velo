/** Decides whether the window may close: only when clean, or after the user confirms discarding. */
export async function shouldClose(d: {
  flush: () => Promise<boolean>;
  ask: (msg: string) => Promise<boolean>;
  lastError: () => string;
  timeoutMs?: number;
}): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => (t = setTimeout(() => r(false), d.timeoutMs ?? 5000)));
  const clean = await Promise.race([d.flush().catch(() => false), timeout]);
  clearTimeout(t);
  if (clean) return true;
  return d.ask(`Your latest edits could not be saved (${d.lastError() || "timed out"}). Quit anyway and discard them?`);
}
