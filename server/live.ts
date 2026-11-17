import path from "node:path";

const norm = (p: string) => path.resolve(p).replace(/[\/]+$/, "").toLowerCase();

/** True when either directory contains the other (a workspace may hold repos, an agent may sit in a subfolder). */
export function overlaps(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  const within = (p: string, q: string) => p === q || p.startsWith(q + path.sep);
  return within(x, y) || within(y, x);
}

type Listener = { directory: string; notify: () => void };
const listeners = new Set<Listener>();

/** Register an open panel; returns the remover. */
export function addListener(directory: string, notify: () => void): () => void {
  const l = { directory, notify };
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Tell panels whose directory overlaps `directory` (or all, when omitted) that the repo changed. */
export function notifyChanged(directory?: string): void {
  for (const l of listeners) if (!directory || overlaps(l.directory, directory)) l.notify();
}
