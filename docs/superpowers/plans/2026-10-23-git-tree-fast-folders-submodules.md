# Git Tree: fast load, folder workspaces, submodules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Git Tree shows its graph in well under a second, shows submodule line-up/dirty status with drill-in, and turns non-repo workspaces (e.g. `C:\Dev`) into a list of repo cards with worktree folders you can drill into or open as Paseo workspaces.

**Architecture:** The single heavy `gittree.get` RPC is split: graph only (cached, fast) plus a background `gittree.status` RPC (uncommitted summary + submodules). A daemon-memory cache serves the last result instantly, then the client re-asks with `fresh: true`. The existing panel body becomes `RepoView({ directory })`; a new root `GitTreePanel` probes the workspace directory and shows either `RepoView` or a new `RepoList`, with a drill stack for submodules and folders.

**Tech Stack:** TypeScript, React Native (web/desktop/mobile), zod 4, `@getpaseo/plugin` 0.12.0, Node 24 `node --test` with `--experimental-strip-types`, git CLI via `execFile`.

**Spec:** `docs/superpowers/specs/2026-10-23-git-tree-fast-folders-submodules-design.md`

## Global Constraints

- Paseo plugin API 0.12.0 (`@getpaseo/plugin` devDependency). RPC names match `/^[a-z][a-z0-9._-]*$/` (kebab, dotted, never camelCase).
- `shared/` holds zod schemas, contracts and pure functions only — no Node or React Native imports.
- Lucide icon names are exact export names (`LoaderCircle`, `FolderGit2`, `ChevronLeft`).
- Existing branch/commit actions stay live in every view, including drilled-in submodules and worktrees.
- No dedicated submodule actions; no agent launch on "Start workspace".
- Never restart the daemon; verify with `paseo plugin reload git-tree --host <ip>:6767`. Alex supplies `PASEO_PASSWORD`; never store it.
- `npm run typecheck` and `npm test` pass at the end of every task.
- Commit by file name; branch `fast-folders-submodules` in `C:\Dev\paseo-git-tree`.

## Review Focus

1. **Huge or binary untracked files** (pkzip's three 523 MB `.exe`s): summary must finish in < 2 s, files counted as untracked with no lines. Test in Task 1.
2. **Windows junctions / symlink loops in a folder scan**: walk must not follow them. Test in Task 5.
3. **Uninitialised submodule** (`-` in `git submodule status`, empty dir): listed, not drillable, no crash. Test in Task 2.
4. **Expected commit not on the checked-out branch** (parent moved, submodule not updated): the drilled-in graph must still contain the expected commit. Test in Task 2 (`extraRefs`).
5. **Folder scanned that is itself inside a repo** (workspace = `C:\Dev\pkzip\docs`): probe reports repo, not folder. Test in Task 5.

---

### Task 1: Shared git runner, cache and fast untracked counting

**Files:**
- Create: `server/git.ts`, `server/cache.ts`, `server/git.test.ts`
- Modify: `server/git-tree.ts` (import `runGit`, `countUntracked` from `./git`; delete local `runGit`, `untrackedLineCounts`; use `countUntracked` in `getGitTree` and `worktreeFiles`)
- Modify: `package.json` (`"test": "node --experimental-strip-types --test shared/*.test.ts server/*.test.ts"`)

**Interfaces:**
- Produces (`server/git.ts`):
  - `runGit(directory: string, args: string[], timeoutMs?: number, allowExit?: number[]): Promise<string>` — moved unchanged.
  - `countUntracked(directory: string, paths: string[], opts?: { maxBytes?: number; concurrency?: number }): Promise<Map<string, { additions: number; binary: boolean }>>` — defaults `maxBytes = 1_048_576`, `concurrency = 4`. Paths ending in `/` (untracked dirs) and files larger than `maxBytes` (via `fs.stat`) get `{ additions: 0, binary: true }` without running git; others use the existing `git diff --no-index --numstat` against `NUL`/`/dev/null`; numstat `-` → `binary: true`.
- Produces (`server/test-helpers.ts`, tests only): `makeTempRepo(): Promise<string>` (git init on branch `main`, local user config, one commit) and `git(dir: string, ...args: string[]): Promise<string>`.
- Produces (`server/cache.ts`): `createCache<T>(): { get(key: string): T | undefined; set(key: string, value: T): void; drop(prefix: string): void }` — plain `Map`, no TTL (`drop` removes keys starting with prefix; used after branch/commit ops).

- [ ] **Step 1:** `npm install` in `C:\Dev\paseo-git-tree`; then confirm in `node_modules/@getpaseo/plugin/dist` that `PluginHandlerContext.paseo.workspaces.open({ cwd })` and `navigation?.openWorkspace({ workspaceId })` exist. Record any signature difference in the task report. Run `npm test` — Expected: existing tests PASS.
- [ ] **Step 2: Write failing tests** in `server/git.test.ts`:
  - `countUntracked skips files over maxBytes without reading them` — temp repo, write a 2 MiB file `big.bin`; `countUntracked(dir, ["big.bin"])` → `{ additions: 0, binary: true }`, resolves in < 500 ms.
  - `countUntracked counts lines of small text files` — `a.txt` with 3 lines → `{ additions: 3, binary: false }`.
  - `countUntracked treats untracked directories as binary` — `["sub/"]` → `{ additions: 0, binary: true }`.
  - `cache drop removes keys by prefix` — set `"C:/a|x"`, `"C:/a|y"`, `"C:/b|x"`; `drop("C:/a|")`; only `"C:/b|x"` remains.
- [ ] **Step 3:** Run `npm test` — Expected: FAIL (`server/git.ts` missing).
- [ ] **Step 4:** Implement `server/git.ts`, `server/cache.ts`, `server/test-helpers.ts`; switch `server/git-tree.ts` to them (summary sums `additions`; `binary` entries add 0).
- [ ] **Step 5:** Run `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 6:** Commit `server/git.ts server/cache.ts server/test-helpers.ts server/git.test.ts server/git-tree.ts package.json package-lock.json`: `"Fast untracked counting: size/binary skip, bounded parallelism"`.

### Task 2: Split graph and status RPCs; submodule status

**Files:**
- Modify: `shared/git-tree.ts` (contracts + parsers), `shared/git-tree.test.ts`
- Create: `server/status.ts`, `server/status.test.ts`
- Modify: `server/git-tree.ts` (`getGitTree`: graph only, cache, `extraRefs`), `index.server.ts`

**Interfaces:**
- `gitTree` (`gittree.get`) input adds `extraRefs: z.array(z.string().regex(/^[0-9a-f]{7,64}$/i)).optional()` (appended to the `git log` refs) and `fresh: z.boolean().optional()`. Output: **remove** `uncommitted`; add `cached: z.boolean()`.
- New `gitStatus = defineRpc({ name: "gittree.status", input: { directory, fresh?: boolean }, output: { uncommitted: <existing uncommitted schema, moved>, submodules: z.array(submoduleSchema), cached: z.boolean(), error: z.string().nullable() } })`.
- `submoduleSchema = z.object({ path: z.string(), expected: z.string().nullable(), committed: z.string().nullable(), checkedOut: z.string().nullable(), branch: z.string().nullable(), state: z.enum(["ok", "mismatch", "uninitialized", "conflict"]), dirty: z.boolean() })`. `expected` = parent index (`git ls-files -s`, mode 160000), `committed` = parent HEAD (`git ls-tree HEAD`), `checkedOut` = hash from `git submodule status` (null when uninitialised), `branch` = `rev-parse --abbrev-ref HEAD` in the submodule, null when `HEAD`/uninitialised.
- Pure parsers in `shared/git-tree.ts`:
  - `parseSubmoduleStatus(text: string): { path: string; hash: string; flag: " " | "+" | "-" | "U" }[]`
  - `parseGitlinks(text: string): Map<string, string>` — parses both `ls-files -s` (`160000 <sha> 0\t<path>`) and `ls-tree` (`160000 commit <sha>\t<path>`) lines; ignores non-160000 modes.
  - `parsePorcelainV2SubmoduleDirty(text: string): Map<string, boolean>` — from `git status --porcelain=v2` lines whose sub field starts with `S`; dirty when `m === "M"` or `u === "U"` (`S<c><m><u>`).
- `server/status.ts`: `getStatus(input): Promise<GitStatusOutput>`; cache key `${directory}|status`. `getGitTree` cache key `${directory}|${scope}|${path ?? ""}|${preview ?? ""}|${(extraRefs ?? []).join(",")}`. When `fresh` is false and a cached value exists, return it with `cached: true`; otherwise compute, store, return `cached: false`. `runBranchOp`/`runCommitOp` call `cache.drop(directory + "|")` on success.

- [ ] **Step 1: Write failing tests**:
  - `shared/git-tree.test.ts`: `parseSubmoduleStatus reads all four flags` (input lines ` abc… SDK (heads/main)`, `+def… Agent/metaclient (v1-2-gdef)`, `-0123… conan/profiles`, `U4567… x`), `parseGitlinks handles ls-files and ls-tree forms and skips 100644`, `parsePorcelainV2SubmoduleDirty flags S.M. and S..U, not SC..`.
  - `server/status.test.ts` (temp parent + temp child repo, `git -c protocol.file.allow=always submodule add <child> sub`, commit):
    - `status reports ok submodule on its branch, not dirty`.
    - `status reports mismatch after parent HEAD moves` — commit in child, bump pointer in parent, commit; `git checkout HEAD~1` in parent (no submodule update) → `state: "mismatch"`, `expected !== checkedOut`.
    - `status reports uninitialized submodule` — fresh `git clone` of the parent without `--recurse-submodules` → `state: "uninitialized"`, `checkedOut: null`, `branch: null`.
    - `status reports committed when pointer is staged but not committed` — `committed !== expected`.
    - `graph includes extraRefs commit not reachable from HEAD` — child repo: commit X on branch `side`, checkout `main`; `getGitTree({ directory: child, scope: "current", extraRefs: [X] })` rows contain X.
    - `getGitTree returns cached: true on second call without fresh`.
- [ ] **Step 2:** Run `npm test` — Expected: FAIL.
- [ ] **Step 3:** Implement contracts, parsers, `server/status.ts`, `getGitTree` changes; register `gitStatus` in `index.server.ts`.
- [ ] **Step 4:** In `client/git-tree-panel.tsx`, replace the `data?.uncommitted` use with `null` (Task 3 wires `gitStatus` in) so the client compiles.
- [ ] **Step 5:** Run `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 6:** Commit `shared/git-tree.ts shared/git-tree.test.ts server/status.ts server/status.test.ts server/git-tree.ts index.server.ts client/git-tree-panel.tsx`: `"Split graph and status RPCs; submodule status"`.

### Task 3: Client fast load, background status, visible loading and errors

**Files:**
- Modify: `client/git-tree-panel.tsx` (`GitTreePanel` → extract body into `export function RepoView(props: RepoViewProps)`)

**Interfaces:**
- Consumes: `gitTree` (`cached`, `fresh`, `extraRefs`), `gitStatus`.
- Produces: `type RepoViewProps = { directory: string; theme: PluginTheme; layout: PluginHostProps["layout"]; extraRefs?: string[]; marks?: Record<string, string[]>; onOpenSubmodule?: (sub: Submodule) => void; header?: ReactNode }` and `export function RepoView(props: RepoViewProps)`. `GitTreePanel` temporarily renders `<RepoView directory={workspace.directory} … />` (Task 6 replaces it). `type Submodule = z.output<typeof submoduleSchema>` exported from `shared/git-tree.ts`.

- [ ] **Step 1:** Extract `RepoView` from `GitTreePanel` (pure move; `workspace` lookup stays in `GitTreePanel`). Move the hooks above the `if (!workspace)` early return while doing so (hooks currently run after it).
- [ ] **Step 2:** `loadTree(opts)`: first call per directory/scope uses `fresh: false`; when the response has `cached: true`, render it and immediately re-call with `fresh: true` under the same `loadGen` guard. Refresh button and post-op reloads pass `fresh: true`. After every tree response, call `gitStatus({ directory, fresh })` the same two-step way and keep it in `status` state; feed `status?.uncommitted ?? null` where `data?.uncommitted` was used.
- [ ] **Step 3:** Rendering: when `loading && rows.length === 0 && !data?.error` show a centered `LoaderCircle` + "Loading…" (reuse `styles.empty`/`styles.emptyText`). On RPC rejection set an `rpcError` string ("Couldn't load the graph: <message>") and render it with the existing error block instead of `setData(null)` silently.
- [ ] **Step 4:** Run `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 5:** Manual check (needs Alex for `PASEO_PASSWORD`): `paseo plugin reload git-tree --host <ip>:6767`; open Git Tree in the `C:\Dev\pkzip` workspace — graph visible in < 2 s, uncommitted row appears afterwards; refresh icon un-dims. If the daemon is unreachable, record "reload verification pending" in the report.
- [ ] **Step 6:** Commit `client/git-tree-panel.tsx shared/git-tree.ts`: `"Render graph first, load status in the background, show loading and errors"`.

### Task 4: Submodule strip, drill-in and commit marks

**Files:**
- Create: `client/submodule-strip.tsx`
- Modify: `client/git-tree-panel.tsx` (`RepoView` renders strip; `CommitRow` renders marks; `GitTreePanel` holds drill stack)

**Interfaces:**
- Consumes: `RepoViewProps.extraRefs`, `marks`, `onOpenSubmodule`, `header`; `Submodule`.
- Produces: `export function SubmoduleStrip(props: { submodules: Submodule[]; theme: PluginTheme; onOpen: (s: Submodule) => void })` — one compact row per submodule: path, branch or "detached", a state badge (`ok` muted check; `mismatch` warning "doesn't match parent"; `uninitialized` muted "not initialised"; `conflict` danger), a "dirty" badge when `dirty`. Uninitialised rows are not pressable. Hidden when the list is empty.
- Drill stack in `GitTreePanel`: `type ViewEntry = { kind: "repo"; directory: string; label: string; extraRefs?: string[]; marks?: Record<string, string[]> } | { kind: "folder"; directory: string }` held in `useState<ViewEntry[]>`; the top entry is rendered; `header` shows a `ChevronLeft` back button + breadcrumb labels when the stack has > 1 entry.
- Opening submodule `s` of repo `dir` pushes `{ kind: "repo", directory: path.join(dir, s.path)` (join with `/` on the client — no Node `path`), `label: s.path, extraRefs: [s.expected, s.committed].filter(Boolean), marks }` where `marks[s.expected] = ["parent expects"]`, `marks[s.committed] = ["parent's last commit"]` only when `committed !== expected`, `marks[s.checkedOut] = [..., "checked out"]`.
- `CommitRow` renders each label in `marks[row.hash]` as a chip beside the tag chips (same chip style, accent tint).
- Returning to the parent (back button) reloads the parent's status with `fresh: true` so line-up flags reflect actions taken inside the submodule.

- [ ] **Step 1:** Implement `SubmoduleStrip`; render it in `RepoView` above the list from `status?.submodules`.
- [ ] **Step 2:** Implement drill stack + header/back in `GitTreePanel`, `marks` chips in `CommitRow`.
- [ ] **Step 3:** Run `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 4:** Manual check: reload plugin; in `C:\Dev\pkzip` the strip lists `SDK`, `Agent/metaclient`, `conan/profiles`; drill into `SDK` → its graph shows "parent expects" + "checked out" chips; drill into `SDK/Docs`; back twice returns to pkzip. Branch menu inside `SDK` works (e.g. preview a branch).
- [ ] **Step 5:** Commit `client/submodule-strip.tsx client/git-tree-panel.tsx`: `"Submodule strip with drill-in and parent/checkout marks"`.

### Task 5: Folder discovery, worktree grouping, folder status (server)

**Files:**
- Create: `server/repos.ts`, `server/repos.test.ts`
- Modify: `shared/git-tree.ts`, `shared/git-tree.test.ts`, `index.server.ts`

**Interfaces:**
- `gitProbe = defineRpc({ name: "gittree.probe", input: { directory }, output: { kind: z.enum(["repo", "folder"]), root: z.string().nullable() } })` — `git rev-parse --show-toplevel`; success → repo, failure → folder.
- `gitRepos = defineRpc({ name: "gittree.repos", input: { directory, fresh?: boolean }, output: { repos: z.array(repoCardSchema), cached: z.boolean(), error: z.string().nullable() } })`; `repoCardSchema = z.object({ name: z.string(), root: z.string(), folders: z.array(z.object({ path: z.string(), name: z.string(), isMain: z.boolean() })) })`. Cards sorted by `name` (case-insensitive); folders main first, then by name.
- `gitFolderStatus = defineRpc({ name: "gittree.folder-status", input: { directories: z.array(z.string()).max(200) }, output: { statuses: z.array(z.object({ path: z.string(), branch: z.string().nullable(), changed: z.number().int(), submodulesOk: z.boolean().nullable(), error: z.string().nullable() })) } })` — per directory, concurrency 4: `rev-parse --abbrev-ref HEAD` (`HEAD` → null), `status --porcelain` line count, `submodule status` → `submodulesOk` null when no submodules, false when any `+`/`U`.
- `server/repos.ts`: `findRepos(root: string, opts?: { maxDepth?: number; skip?: Set<string> }): Promise<string[]>` — BFS with `fs.readdir(dir, { withFileTypes: true })`; a directory containing a `.git` entry (file or dir) is a repo: record, don't descend. Never follow `isSymbolicLink()` entries (Windows junctions report as symlinks). Default `maxDepth = 6`; default skip: `node_modules`, `.venv`, `venv`, `__pycache__`, `bin`, `obj`, and any name starting with `.`. Unreadable dirs are skipped silently.
- Pure in `shared/git-tree.ts`: `parseWorktreeList(text: string): { path: string; branch: string | null; bare: boolean; prunable: boolean }[]` (from `git worktree list --porcelain`), and `groupRepos(found: { path: string; worktrees: ReturnType<typeof parseWorktreeList> }[]): RepoCard[]` — card key is the first non-bare worktree's path normalised (lower-case, `\` → `/`, no trailing `/`); bare and prunable entries are dropped; a found repo already present as a worktree of another card is merged, not duplicated; `name` = basename of the main path.

- [ ] **Step 1: Write failing tests**:
  - `shared/git-tree.test.ts`: `parseWorktreeList reads main, linked, detached, bare and prunable entries`; `groupRepos merges a worktree found by the walk into its main card`; `groupRepos keys case-insensitively on Windows-style paths`.
  - `server/repos.test.ts` (temp dir): `findRepos finds top-level and one-deeper repos and stops at repo roots` (`a/` repo containing nested `a/inner/` repo → only `a`; `group/b/` repo → found); `findRepos skips node_modules and dot dirs`; `findRepos does not follow junctions/symlinks` (create a dir symlink — on Windows `fs.symlink(target, link, "junction")` — pointing back to root; walk terminates and finds each repo once); `probe reports repo for a subfolder of a repo` (Review Focus 5); `repos groups a worktree under its main repo` (`git worktree add ../wt`); `folder-status reports branch, changed count and submodulesOk`.
- [ ] **Step 2:** Run `npm test` — Expected: FAIL.
- [ ] **Step 3:** Implement; repos cache key `${directory}|repos`; register the three RPCs.
- [ ] **Step 4:** Run `npm test && npm run typecheck` — Expected: PASS. Also time `findRepos("C:\\Dev")` once from a scratch script and record the duration and repo count in the report (target: seconds, not minutes).
- [ ] **Step 5:** Commit `shared/git-tree.ts shared/git-tree.test.ts server/repos.ts server/repos.test.ts index.server.ts`: `"Folder discovery with worktree grouping and folder status"`.

### Task 6: Folder view and Start workspace (client + one RPC)

**Files:**
- Create: `client/repo-list.tsx`
- Modify: `client/git-tree-panel.tsx` (`GitTreePanel` root), `shared/git-tree.ts`, `index.server.ts`

**Interfaces:**
- `gitOpenWorkspace = defineRpc({ name: "gittree.open-workspace", input: { directory }, output: { workspaceId: z.string().nullable(), error: z.string().nullable() } })`; handler uses `context.paseo.workspaces.open({ cwd: directory })` and returns `handle.id` (adjust to the 0.12.0 signature recorded in Task 1).
- `export function RepoList(props: { directory: string; theme: PluginTheme; layout: PluginHostProps["layout"]; onDrill: (folder: { path: string; name: string }) => void; onStartWorkspace?: (path: string) => void })` — loads `gitRepos` (cached-then-fresh, like Task 3), renders cards immediately, then calls `gitFolderStatus` for all folder paths in batches of 50 and fills in `branch · N changed` and a submodule warning badge when `submodulesOk === false`. Each folder line: press → `onDrill`; a trailing "Start" button → `onStartWorkspace` (hidden when the prop is undefined). Loading indicator and error text as in Task 3; refresh button rescans with `fresh: true`.
- `GitTreePanel`: on mount call `gitProbe(workspace.directory)`; initial stack entry is `{ kind: "repo", directory: root, label }` or `{ kind: "folder", directory }`. `onDrill` pushes a repo entry; `onStartWorkspace` calls `gitOpenWorkspace` then `navigation.openWorkspace({ workspaceId })`, toast on error; passed only when `navigation?.openWorkspace` exists.

- [ ] **Step 1:** Implement `gitOpenWorkspace` contract + handler.
- [ ] **Step 2:** Implement `RepoList` and the probe-driven root in `GitTreePanel`.
- [ ] **Step 3:** Run `npm run typecheck && npm test` — Expected: PASS.
- [ ] **Step 4:** Manual check: reload plugin; open Git Tree on the `C:\Dev` workspace — cards appear (pkzip card lists `pkzip`, `pkzip-PEM-3577`, `pkzip-PEM-3929`, `pkzip-PEM-4086`), branch/changed fill in after; `GitHub/*` and `3rdparty` cards present; drill into a folder and back; "Start" on `pkzip-PEM-4086` opens/switches to that workspace.
- [ ] **Step 5:** Commit `client/repo-list.tsx client/git-tree-panel.tsx shared/git-tree.ts index.server.ts`: `"Folder workspaces: repo cards, drill-in, start workspace"`.

### Task 7: Ship

**Files:**
- Modify: `README.md` (short "Folder workspaces" and "Submodules" sections)
- In `C:\Dev\paseo-config` (on a branch from up-to-date `main`): `plugins.json` (`git-tree.commit`), rendered `hosts/*/config.json`

- [ ] **Step 1:** Update README; commit `README.md`: `"Document folder workspaces and submodule view"`.
- [ ] **Step 2:** Ask Alex before pushing; then `git push -u origin fast-folders-submodules` and merge to the fork's `main` (his choice: PR or fast-forward).
- [ ] **Step 3:** In paseo-config: `git switch main && git pull`, new branch, set `git-tree.commit` to the merged `main` SHA, PowerShell `$env:PYTHONPATH="$PWD\scripts"; python -m fleet render`, run the fleet tests, commit `plugins.json` and changed host configs by name.
- [ ] **Step 4:** Offer `paseo-release`; do not run it without Alex's yes.
