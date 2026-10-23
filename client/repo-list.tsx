import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { gitFolderStatus, gitRepos, type RepoCard } from "../shared/git-tree";

type FolderStatus = { branch: string | null; changed: number; submodulesOk: boolean | null; error: string | null };
type Folder = RepoCard["folders"][number];

const STATUS_BATCH = 50;

function FolderLine({
  folder,
  status,
  theme,
  onDrill,
  onStart,
}: {
  folder: Folder;
  status: FolderStatus | undefined;
  theme: PluginTheme;
  onDrill: () => void;
  onStart?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const c = theme.colors;
  const summary = !status
    ? ""
    : status.error
      ? "unavailable"
      : `${status.branch ?? "detached"} · ${status.changed} changed`;
  // Start sits beside the drill target, not inside it, so a press never does both.
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingRight: 8,
        borderRadius: 6,
        backgroundColor: hovered ? c.surface1 : "transparent",
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onDrill}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8, paddingVertical: 5 }}
      >
        <Icon name={folder.isMain ? "Folder" : "GitBranch"} size={12} color={c.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, flexShrink: 1 }}>
          {folder.name}
        </Text>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, flexShrink: 1 }}>
          {summary}
        </Text>
        {status?.submodulesOk === false ? (
          <View style={{ borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, borderWidth: 1, borderColor: c.statusWarning }}>
            <Text numberOfLines={1} style={{ fontSize: 10, color: c.statusWarning }}>
              submodules out of step
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Icon name="ChevronRight" size={12} color={c.foregroundMuted} />
      </Pressable>
      {onStart ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Start workspace in ${folder.name}`}
          onPress={onStart}
          hitSlop={4}
          style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: c.border }}
        >
          <Text style={{ color: c.foreground, fontSize: 11 }}>Start</Text>
        </Pressable>
        ) : null}
    </View>
  );
}

/** Folder workspace view: one card per repository with its checkouts; branch
 *  and changed counts fill in after the cards render. */
export function RepoList({
  directory,
  theme,
  layout,
  onDrill,
  onStartWorkspace,
}: {
  directory: string;
  theme: PluginTheme;
  layout: PluginHostProps["layout"];
  onDrill: (folder: { path: string; name: string }) => void;
  onStartWorkspace?: (path: string) => void;
}) {
  const getRepos = useRpc(gitRepos);
  const getFolderStatus = useRpc(gitFolderStatus);
  const [repos, setRepos] = useState<RepoCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, FolderStatus>>({});
  /** Paths already fetched or in flight for the current generation. */
  const requested = useRef(new Set<string>());
  const loadGen = useRef(0);
  const c = theme.colors;

  /** Fetches status for paths not yet requested, sequentially in batches. */
  const loadStatuses = useCallback(
    async (id: number, cards: RepoCard[]) => {
      const paths = cards.flatMap((r) => r.folders.map((f) => f.path)).filter((p) => !requested.current.has(p));
      for (const p of paths) requested.current.add(p);
      for (let i = 0; i < paths.length; i += STATUS_BATCH) {
        const slice = paths.slice(i, i + STATUS_BATCH);
        const res = await getFolderStatus({ directories: slice }).catch(() => null);
        if (id !== loadGen.current) return;
        // A failed batch shows as unavailable and is retried on the next load.
        if (!res) for (const p of slice) requested.current.delete(p);
        const statuses = res?.statuses ?? slice.map((path) => ({ path, branch: null, changed: 0, submodulesOk: null, error: "unavailable" }));
        setStatuses((cur) => {
          const next = { ...cur };
          for (const s of statuses) next[s.path] = s;
          return next;
        });
      }
    },
    [getFolderStatus],
  );

  /** Serves the cache first and, on a hit, rescans fresh under the same generation. */
  const load = useCallback(
    (fresh: boolean) => {
      const id = ++loadGen.current;
      if (fresh) {
        requested.current = new Set();
        setStatuses({});
      }
      setLoading(true);
      const fetchRepos = (fresh: boolean): Promise<void> =>
        getRepos({ directory, ...(fresh ? { fresh: true } : {}) }).then((next) => {
          if (id !== loadGen.current) return;
          setRepos(next.repos);
          setError(next.error);
          void loadStatuses(id, next.repos);
          if (next.cached && !fresh) return fetchRepos(true);
        });
      fetchRepos(fresh)
        .catch((err: unknown) => {
          if (id === loadGen.current) {
            setError(`Couldn't list repositories: ${err instanceof Error ? err.message : String(err)}`);
          }
        })
        .finally(() => {
          if (id === loadGen.current) setLoading(false);
        });
    },
    [directory, getRepos, loadStatuses],
  );

  useEffect(() => load(false), [load]);

  const pad = layout.compact ? 6 : 10;
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: pad,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: c.border + "66",
        }}
      >
        <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12, fontWeight: "600" }}>
          {repos ? `${repos.length} repositories` : "Repositories"}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh" onPress={() => load(true)} hitSlop={8} style={{ padding: 6 }}>
          <Icon name="RefreshCw" size={14} color={loading ? c.foregroundMuted : c.foreground} />
        </Pressable>
      </View>
      {error ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12 }}>
          <Icon name="CircleAlert" size={16} color={c.statusDanger} />
          <Text style={{ flex: 1, color: c.statusDanger, fontSize: 12 }}>{error}</Text>
        </View>
      ) : null}
      {!repos || (repos.length === 0 && !error) ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 }}>
          <Icon name={loading ? "LoaderCircle" : "FolderGit2"} size={18} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {loading ? "Loading…" : "No git repositories found"}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: pad, gap: 8 }}>
          {repos.map((repo) => (
            <View
              key={repo.root}
              style={{ borderWidth: 1, borderColor: c.border + "66", borderRadius: 8, padding: 4, backgroundColor: c.surface0 }}
            >
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 4 }}>
                {repo.name}
              </Text>
              {repo.folders.map((f) => (
                <FolderLine
                  key={f.path}
                  folder={f}
                  status={statuses[f.path]}
                  theme={theme}
                  onDrill={() => onDrill({ path: f.path, name: f.name })}
                  onStart={onStartWorkspace ? () => onStartWorkspace(f.path) : undefined}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
