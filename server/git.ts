import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export function runGit(
  directory: string,
  args: string[],
  timeoutMs = 15_000,
  allowExit: number[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: directory, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const code = (err as { code?: unknown }).code;
        if (typeof code === "number" && allowExit.includes(code)) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || err.message));
      },
    );
  });
}

export type UntrackedCount = { additions: number; binary: boolean };

/**
 * Line counts for untracked paths (every line is an addition). Directories and
 * files over `maxBytes` are reported as binary without running git, so huge
 * untracked files are never read. Others use `git diff --no-index --numstat`
 * so CRLF/encoding handling matches the inline diff.
 */
export async function countUntracked(
  directory: string,
  paths: string[],
  opts: { maxBytes?: number; concurrency?: number } = {},
): Promise<Map<string, UntrackedCount>> {
  const maxBytes = opts.maxBytes ?? 1_048_576;
  const concurrency = opts.concurrency ?? 4;
  const emptyBlob = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = new Map<string, UntrackedCount>();

  async function count(p: string): Promise<UntrackedCount> {
    if (p.endsWith("/")) return { additions: 0, binary: true };
    try {
      if ((await stat(path.resolve(directory, p))).size > maxBytes) return { additions: 0, binary: true };
    } catch {
      return { additions: 0, binary: false };
    }
    const out = await runGit(directory, ["diff", "--no-index", "--numstat", "--", emptyBlob, p], 15_000, [1]).catch(() => "");
    const a = out.split("\n")[0]?.split("\t")[0] ?? "0";
    return a === "-" ? { additions: 0, binary: true } : { additions: Number.parseInt(a, 10) || 0, binary: false };
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (next < paths.length) {
        const p = paths[next++];
        result.set(p, await count(p));
      }
    }),
  );
  return result;
}
