import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
  });
}

/** Fresh repo on branch `main` with local user config and one commit. */
export async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "git-tree-"));
  await git(dir, "init", "-b", "main");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "README.md"), "init\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "-m", "init");
  return dir;
}
