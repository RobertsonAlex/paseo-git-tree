import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Submodule } from "../shared/git-tree";

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        borderRadius: 4,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderWidth: 1,
        borderColor: color.length === 7 ? color + "99" : color,
      }}
    >
      <Text numberOfLines={1} style={{ fontSize: 10, color }}>
        {label}
      </Text>
    </View>
  );
}

function StripRow({ sub, theme, onOpen }: { sub: Submodule; theme: PluginTheme; onOpen: (s: Submodule) => void }) {
  const [hovered, setHovered] = useState(false);
  const c = theme.colors;
  const pressable = sub.state !== "uninitialized";
  return (
    <Pressable
      accessibilityRole={pressable ? "button" : undefined}
      disabled={!pressable}
      onPress={() => onOpen(sub)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: pressable && hovered ? c.surface1 : "transparent",
      }}
    >
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
        {sub.path}
      </Text>
      {sub.checkedOut ? (
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, flexShrink: 1 }}>
          {sub.branch ?? "detached"}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      {sub.state === "ok" ? <Icon name="Check" size={12} color={c.foregroundMuted} /> : null}
      {sub.state === "mismatch" ? <Badge label="doesn't match parent" color={c.statusWarning} /> : null}
      {sub.state === "uninitialized" ? <Badge label="not initialised" color={c.foregroundMuted} /> : null}
      {sub.state === "conflict" ? <Badge label="conflict" color={c.statusDanger} /> : null}
      {sub.dirty ? <Badge label="dirty" color={c.statusWarning} /> : null}
      {pressable ? <Icon name="ChevronRight" size={12} color={c.foregroundMuted} /> : null}
    </Pressable>
  );
}

/** One compact row per submodule; press to drill in. Hidden when there are none. */
export function SubmoduleStrip({
  submodules,
  theme,
  onOpen,
}: {
  submodules: Submodule[];
  theme: PluginTheme;
  onOpen: (s: Submodule) => void;
}) {
  if (submodules.length === 0) return null;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border + "66",
      }}
    >
      {submodules.map((s) => (
        <StripRow key={s.path} sub={s} theme={theme} onOpen={onOpen} />
      ))}
    </View>
  );
}
