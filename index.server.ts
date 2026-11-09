import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getCommitCompare,
  getCommitCompareDiff,
  getCommitDetail,
  getCommitDiff,
  getGitTree,
  runBranchOp,
  runCommitOp,
} from "./server/git-tree";
import { dropRepoCache, getFolderStatus, getProbe, getRepos, openWorkspace } from "./server/repos";
import { getStatus } from "./server/status";
import {
  commitCompare,
  commitCompareDiff,
  commitDetail,
  commitDiff,
  gitBranchOp,
  gitCommitOp,
  gitFolderStatus,
  gitOpenWorkspace,
  gitProbe,
  gitRepos,
  gitStatus,
  gitTree,
} from "./shared/git-tree";

export default function contribute(server: PluginServerContext) {
  server.handle(gitTree, getGitTree);
  server.handle(gitStatus, getStatus);
  server.handle(commitDetail, getCommitDetail);
  server.handle(commitDiff, getCommitDiff);
  server.handle(commitCompare, getCommitCompare);
  server.handle(commitCompareDiff, getCommitCompareDiff);
  server.handle(gitBranchOp, runBranchOp);
  server.handle(gitCommitOp, runCommitOp);
  server.handle(gitProbe, getProbe);
  server.handle(gitRepos, getRepos);
  server.handle(gitFolderStatus, getFolderStatus);
  server.handle(gitOpenWorkspace, openWorkspace);

  // server.addHook arrives in Paseo 0.15 and isn't in the 0.14 SDK types; on 0.14 the cache just never expires.
  const hooks = server as unknown as { addHook?: (name: string, handler: () => Promise<void>) => () => void };
  const removers =
    typeof hooks.addHook === "function"
      ? ["worktree.create.after", "workspace.archive.after"].map((name) => hooks.addHook!(name, async () => dropRepoCache()))
      : [];
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}
