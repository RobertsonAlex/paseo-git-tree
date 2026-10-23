import path from "node:path";
import type { output as ZodOutput } from "zod";
import {
  parseGitlinks,
  parsePorcelainV2SubmoduleDirty,
  parseSubmoduleStatus,
  type GitStatusOutput,
  type gitStatus,
  type Submodule,
} from "../shared/git-tree.ts";
import { createCache } from "./cache.ts";
import { countUntracked, runGit } from "./git.ts";

type Input = ZodOutput<typeof gitStatus.input>;

const cache = createCache<GitStatusOutput>();

export function dropStatusCache(prefix: string): void {
  cache.drop(prefix);
}

function unquotePorcelainPath(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  return t;
}

/** Index + worktree + untracked vs HEAD. Best-effort: null when clean or no commits. */
async function uncommittedSummary(
  directory: string,
  statusOut: string,
): Promise<GitStatusOutput["uncommitted"]> {
  try {
    const numstat = await runGit(directory, ["diff", "HEAD", "--numstat"]).catch(() => "");
    let additions = 0;
    let deletions = 0;
    let tracked = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [a = "0", d = "0"] = line.split("\t");
      tracked++;
      additions += a === "-" ? 0 : Number.parseInt(a, 10) || 0;
      deletions += d === "-" ? 0 : Number.parseInt(d, 10) || 0;
    }
    const untrackedPaths: string[] = [];
    for (const line of statusOut.split("\n")) {
      if (line.startsWith("? ")) untrackedPaths.push(unquotePorcelainPath(line.slice(2)));
    }
    const untracked = untrackedPaths.length;
    // Untracked files contribute their full line count as additions —
    // `git diff HEAD` never sees them.
    for (const c of (await countUntracked(directory, untrackedPaths)).values()) additions += c.additions;
    return tracked > 0 || untracked > 0
      ? { count: tracked + untracked, additions, deletions, untracked }
      : null;
  } catch {
    return null;
  }
}

async function submoduleList(directory: string, statusOut: string): Promise<Submodule[]> {
  const expected = parseGitlinks(await runGit(directory, ["ls-files", "-s"]).catch(() => ""));
  if (expected.size === 0) return [];
  const paths = [...expected.keys()];
  const [treeOut, subOut] = await Promise.all([
    runGit(directory, ["ls-tree", "HEAD", "--", ...paths]).catch(() => ""),
    runGit(directory, ["submodule", "status"]).catch(() => ""),
  ]);
  const committed = parseGitlinks(treeOut);
  const flags = new Map(parseSubmoduleStatus(subOut).map((s) => [s.path, s]));
  const dirty = parsePorcelainV2SubmoduleDirty(statusOut);
  return Promise.all(
    paths.map(async (p): Promise<Submodule> => {
      const s = flags.get(p);
      const uninit = !s || s.flag === "-";
      const checkedOut = uninit ? null : s.hash;
      let branch: string | null = null;
      if (!uninit) {
        const out = await runGit(path.resolve(directory, p), ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
        const name = out.trim();
        branch = name && name !== "HEAD" ? name : null;
      }
      const exp = expected.get(p) ?? null;
      const state: Submodule["state"] =
        s?.flag === "U" ? "conflict" : uninit ? "uninitialized" : checkedOut !== exp ? "mismatch" : "ok";
      return {
        path: p,
        expected: exp,
        committed: committed.get(p) ?? null,
        checkedOut,
        branch,
        state,
        dirty: dirty.get(p) ?? false,
      };
    }),
  );
}

export async function getStatus(input: Input): Promise<GitStatusOutput> {
  const directory = path.resolve(input.directory);
  const key = `${directory}|status`;
  if (!input.fresh) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
  }
  try {
    const statusOut = await runGit(directory, ["status", "--porcelain=v2"]);
    const [uncommitted, submodules] = await Promise.all([
      uncommittedSummary(directory, statusOut),
      submoduleList(directory, statusOut),
    ]);
    const result: GitStatusOutput = { uncommitted, submodules, cached: false, error: null };
    cache.set(key, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { uncommitted: null, submodules: [], cached: false, error: message };
  }
}
