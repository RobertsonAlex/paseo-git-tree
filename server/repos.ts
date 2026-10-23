import { readdir } from "node:fs/promises";
import path from "node:path";
import type { output as ZodOutput } from "zod";
import {
  groupRepos,
  parseSubmoduleStatus,
  parseWorktreeList,
  type RepoCard,
  type gitFolderStatus,
  type gitOpenWorkspace,
  type gitProbe,
  type gitRepos,
} from "../shared/git-tree.ts";
import { createCache } from "./cache.ts";
import { runGit } from "./git.ts";

const DEFAULT_SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", "bin", "obj"]);

/** BFS for directories containing `.git`; never descends into repos or symlinks/junctions. */
export async function findRepos(
  root: string,
  opts: { maxDepth?: number; skip?: Set<string> } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 6;
  const skip = opts.skip ?? DEFAULT_SKIP;
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; level.length && depth <= maxDepth; depth++) {
    const next: string[] = [];
    await Promise.all(
      level.map(async (dir) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        if (entries.some((e) => e.name === ".git")) {
          found.push(dir);
          return;
        }
        for (const e of entries) {
          if (e.isDirectory() && !e.isSymbolicLink() && !skip.has(e.name) && !e.name.startsWith(".")) {
            next.push(path.join(dir, e.name));
          }
        }
      }),
    );
    level = next;
  }
  return found;
}

export async function getProbe(input: ZodOutput<typeof gitProbe.input>): Promise<ZodOutput<typeof gitProbe.output>> {
  try {
    const root = (await runGit(input.directory, ["rev-parse", "--show-toplevel"])).trim();
    return { kind: "repo", root };
  } catch {
    return { kind: "folder", root: null };
  }
}

const cache = createCache<RepoCard[]>();

export async function getRepos(input: ZodOutput<typeof gitRepos.input>): Promise<ZodOutput<typeof gitRepos.output>> {
  const key = `${input.directory}|repos`;
  const hit = input.fresh ? undefined : cache.get(key);
  if (hit) return { repos: hit, cached: true, error: null };
  try {
    const paths = await findRepos(input.directory);
    const found = await Promise.all(
      paths.map(async (p) => ({
        path: p,
        worktrees: parseWorktreeList(await runGit(p, ["worktree", "list", "--porcelain"]).catch(() => "")),
      })),
    );
    const repos = groupRepos(found);
    cache.set(key, repos);
    return { repos, cached: false, error: null };
  } catch (e) {
    return { repos: [], cached: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type Status = ZodOutput<typeof gitFolderStatus.output>["statuses"][number];

async function folderStatus(dir: string): Promise<Status> {
  try {
    const head = (await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const changed = (await runGit(dir, ["status", "--porcelain"])).split("\n").filter((l) => l.trim()).length;
    const subs = parseSubmoduleStatus(await runGit(dir, ["submodule", "status"]).catch(() => ""));
    return {
      path: dir,
      branch: head === "HEAD" ? null : head,
      changed,
      submodulesOk: subs.length ? !subs.some((s) => s.flag === "+" || s.flag === "U") : null,
      error: null,
    };
  } catch (e) {
    return { path: dir, branch: null, changed: 0, submodulesOk: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getFolderStatus(
  input: ZodOutput<typeof gitFolderStatus.input>,
): Promise<ZodOutput<typeof gitFolderStatus.output>> {
  const statuses: Status[] = new Array(input.directories.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, input.directories.length) }, async () => {
      while (next < input.directories.length) {
        const i = next++;
        statuses[i] = await folderStatus(input.directories[i]);
      }
    }),
  );
  return { statuses };
}

/** Opens (or creates) the Paseo workspace for a folder. Git hands back `C:/...`
 *  paths; resolve to native separators so Paseo matches an existing workspace. */
export async function openWorkspace(
  input: ZodOutput<typeof gitOpenWorkspace.input>,
  context: { paseo: { workspaces: { open(input: { cwd: string }): Promise<{ id: string }> } } },
): Promise<ZodOutput<typeof gitOpenWorkspace.output>> {
  try {
    const handle = await context.paseo.workspaces.open({ cwd: path.resolve(input.directory) });
    return { workspaceId: handle.id, error: null };
  } catch (e) {
    return { workspaceId: null, error: `Couldn't open workspace: ${e instanceof Error ? e.message : String(e)}` };
  }
}
