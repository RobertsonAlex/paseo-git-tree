import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

/** Never prompt for credentials (a prompt would hang the panel); English messages; no optional index locks. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

const MAX_OUTPUT = 32 * 1024 * 1024;

/** Kill git and its helpers (credential managers, ssh), which can keep the pipes open after git dies. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function runGit(
  directory: string,
  args: string[],
  timeoutMs = 15_000,
  allowExit: number[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    // detached on POSIX: own process group (killable as a tree) and no controlling tty to prompt on.
    const child = spawn("git", args, {
      cwd: directory,
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stderr = () => Buffer.concat(errOut).toString("utf8").trim();
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr() || message));
    };
    // Settles on timeout even if a surviving helper still holds the pipes.
    const timer = setTimeout(() => {
      killTree(child.pid);
      fail(`Command timed out after ${timeoutMs}ms: git ${args.join(" ")}`);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUTPUT) {
        killTree(child.pid);
        fail("stdout maxBuffer length exceeded");
      } else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => errOut.push(d));
    child.on("error", (err) => fail(err.message));
    child.on("close", (code) => {
      if (code === 0 || (code !== null && allowExit.includes(code))) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(out).toString("utf8"));
        return;
      }
      fail(`Command failed: git ${args.join(" ")}`);
    });
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
