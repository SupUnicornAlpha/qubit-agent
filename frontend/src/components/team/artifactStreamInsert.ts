/**
 * 把本轮产物插入到对话流：优先紧跟创建类工具调用，否则按 createdAt 落到时间序位置。
 */

export type StreamInsertArtifact = {
  id: string;
  kind: "factor" | "strategy" | "script";
  title: string;
  subtitle?: string;
  createdAt?: string | null;
};

export type TimestampedStreamAnchor = {
  index: number;
  toolName?: string | null;
  contentText?: string;
  ts?: string | null;
  isTool: boolean;
};

const CREATE_TOOL_HINTS: Record<StreamInsertArtifact["kind"], RegExp[]> = {
  factor: [/factor\.register/i, /factor\.create/i, /factor_register/i, /factor\.auto/i],
  strategy: [/strategy\.create_version/i, /strategy\.create/i, /create_version/i],
  script: [/script\./i, /strategy_script/i, /indicator_script/i, /save_script/i],
};

export function toolMatchesArtifactKind(
  toolName: string | null | undefined,
  kind: StreamInsertArtifact["kind"]
): boolean {
  const name = toolName ?? "";
  return CREATE_TOOL_HINTS[kind].some((re) => re.test(name));
}

export function toolMentionsArtifact(
  toolName: string | null | undefined,
  contentText: string | undefined,
  artifact: StreamInsertArtifact
): boolean {
  const hay = `${toolName ?? ""}\n${contentText ?? ""}`;
  if (artifact.id && hay.includes(artifact.id)) return true;
  const title = artifact.title?.trim();
  if (title && title.length >= 2 && hay.includes(title)) return true;
  return false;
}

function parseMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/** 为单个产物找插入锚点（插在该 index 之后）。找不到返回 -1（表示流首之前 / 空流末尾由调用方处理）。 */
export function findArtifactInsertAfterIndex(
  anchors: TimestampedStreamAnchor[],
  artifact: StreamInsertArtifact
): number {
  if (anchors.length === 0) return -1;

  let bestIdx: number | null = null;
  let bestScore = -1;

  for (const a of anchors) {
    if (!a.isTool) continue;
    if (!toolMatchesArtifactKind(a.toolName, artifact.kind)) continue;

    let score = 1;
    if (toolMentionsArtifact(a.toolName, a.contentText, artifact)) score += 10;

    const artMs = parseMs(artifact.createdAt);
    const toolMs = parseMs(a.ts ?? null);
    if (artMs != null && toolMs != null) {
      const dt = artMs - toolMs;
      // 产物在工具调用之后不久（最常见）
      if (dt >= 0 && dt <= 15 * 60 * 1000) score += 4;
      if (Math.abs(dt) <= 2 * 60 * 1000) score += 2;
      // 工具远晚于产物：不太可能
      if (dt < -5 * 60 * 1000) score -= 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = a.index;
    }
  }

  if (bestIdx != null && bestScore > 0) return bestIdx;

  // 时间序回落：插在最后一个 ts <= createdAt 的事件之后
  const artMs = parseMs(artifact.createdAt);
  if (artMs != null) {
    let fallback = -1;
    for (const a of anchors) {
      const ms = parseMs(a.ts ?? null);
      if (ms != null && ms <= artMs) fallback = a.index;
    }
    if (fallback >= 0) return fallback;
  }

  // 无时间信息：放到流末
  return anchors[anchors.length - 1]!.index;
}

/**
 * 计算每个产物应插在哪个 part 索引之后；同锚点的产物按 createdAt 聚到一组。
 * 返回 Map: afterIndex -> artifacts[]
 */
export function groupArtifactsByInsertAnchor(
  anchors: TimestampedStreamAnchor[],
  artifacts: StreamInsertArtifact[]
): Map<number, StreamInsertArtifact[]> {
  const grouped = new Map<number, StreamInsertArtifact[]>();
  if (artifacts.length === 0) return grouped;

  const sorted = [...artifacts].sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
  );

  for (const art of sorted) {
    const after = findArtifactInsertAfterIndex(anchors, art);
    const key = after < 0 ? -1 : after;
    const list = grouped.get(key) ?? [];
    list.push(art);
    grouped.set(key, list);
  }
  return grouped;
}
