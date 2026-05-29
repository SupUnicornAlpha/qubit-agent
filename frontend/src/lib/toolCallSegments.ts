/**
 * 把 LLM 文本里的 `<TOOL_CALL>...</TOOL_CALL>` / 流式截断的 `<TOOL_CALL>...`（未闭合尾部）
 * 与正常 markdown 文本切分开来。
 *
 * 与 `chatMessageHydration.stripToolCallSentinels` 的差异：
 *   - hydration 那边是**过滤掉**工具块（聊天气泡只显示纯文本）
 *   - 这里是**保留并切段**，让 UI 能把工具块渲染成专门的折叠卡片，
 *     不再以 `<TOOL_CALL>{"tool":"code.run_python","params":{...}}` 的明文塞进
 *     markdown，避免在研究产出 / 草稿块里出现一大段无格式的代码污染。
 *
 * 支持三类工具块（最常见的两种 sentinel 形式）：
 *   1. `<TOOL_CALL>{...}</TOOL_CALL>`            —— 标准闭合
 *   2. `<TOOL_CALL>{...`                         —— 流式中途截断（无闭合）
 *   3. ```json {"tool": "...", "params": {...}} ``` —— 老链路用 fenced JSON 替代 sentinel
 *
 * 第 3 种识别规则保守（必须含 `"tool"` 字段），避免误吃普通 JSON 代码块。
 */
export type ToolCallSegment =
  | { kind: "text"; body: string }
  | {
      kind: "tool_call";
      /** 原始 raw（不含 sentinel 标签），便于 fallback 显示 */
      raw: string;
      /** 解析出的 JSON；解析失败时为 null（UI 会回退到 raw 展示） */
      parsed: ToolCallPayload | null;
    };

export interface ToolCallPayload {
  tool?: string;
  /** 一些链路写 `name` 而不是 `tool`，前端两个都认 */
  name?: string;
  params?: Record<string, unknown>;
  /** 老链路 / 部分 connector 用 `arguments` */
  arguments?: Record<string, unknown>;
  [k: string]: unknown;
}

const SENTINEL_CLOSED = /<TOOL_CALL>([\s\S]*?)<\/TOOL_CALL>/i;
const SENTINEL_OPEN_TAIL = /<TOOL_CALL>([\s\S]*)$/i;
const FENCED_JSON_TOOL = /```(?:json)?\s*(\{[\s\S]*?"tool"\s*:[\s\S]*?\})\s*```/i;

function tryParseJson(raw: string): ToolCallPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as ToolCallPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 把输入字符串切成「正常文本 / 工具调用」两类段落，按出现顺序返回。
 * 顺序保留：用户/UI 渲染时按数组顺序输出即可。
 *
 * 算法：循环找最早出现的 sentinel；找不到则把剩余文本作为 text 段；
 * 找到则前面是 text，sentinel 区间是 tool_call。
 *
 * 复杂度 O(n)，不会有回溯爆炸（regex 都是限定长度的非贪婪 / 锚定尾部）。
 */
export function splitToolCallSegments(input: string | null | undefined): ToolCallSegment[] {
  if (!input) return [];
  let rest = String(input);
  const out: ToolCallSegment[] = [];

  while (rest.length > 0) {
    /** 1) 优先匹配闭合的 `<TOOL_CALL>...</TOOL_CALL>` —— 流式完成后大部分是这个形态 */
    const closed = rest.match(SENTINEL_CLOSED);
    /** 2) fenced JSON tool（老链路） */
    const fenced = rest.match(FENCED_JSON_TOOL);

    /** 选最早的命中点 —— 同时存在时按 index 较小的优先 */
    let chosen:
      | { idx: number; raw: string; consumed: number }
      | null = null;

    if (closed && typeof closed.index === "number") {
      chosen = {
        idx: closed.index,
        raw: closed[1] ?? "",
        consumed: closed.index + closed[0].length,
      };
    }
    if (fenced && typeof fenced.index === "number") {
      if (!chosen || fenced.index < chosen.idx) {
        chosen = {
          idx: fenced.index,
          raw: fenced[1] ?? "",
          consumed: fenced.index + fenced[0].length,
        };
      }
    }

    /** 3) 都没命中 —— 检查未闭合尾部（流式 sentinel 被截断） */
    if (!chosen) {
      const openTail = rest.match(SENTINEL_OPEN_TAIL);
      if (openTail && typeof openTail.index === "number") {
        const headText = rest.slice(0, openTail.index);
        if (headText.trim()) out.push({ kind: "text", body: headText });
        const raw = openTail[1] ?? "";
        out.push({ kind: "tool_call", raw, parsed: tryParseJson(raw) });
        rest = "";
        break;
      }
      /** 没有任何 sentinel —— 余下的全部是文本 */
      if (rest.trim()) out.push({ kind: "text", body: rest });
      break;
    }

    /** 命中：先把命中前的文本切出来 */
    const headText = rest.slice(0, chosen.idx);
    if (headText.trim()) out.push({ kind: "text", body: headText });
    out.push({
      kind: "tool_call",
      raw: chosen.raw,
      parsed: tryParseJson(chosen.raw),
    });
    rest = rest.slice(chosen.consumed);
  }

  /** 合并相邻 text 段，去掉首尾空白 */
  return mergeAdjacentText(out);
}

function mergeAdjacentText(segs: ToolCallSegment[]): ToolCallSegment[] {
  const merged: ToolCallSegment[] = [];
  for (const s of segs) {
    if (s.kind === "text") {
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        last.body = `${last.body}\n\n${s.body}`.replace(/\n{3,}/g, "\n\n");
        continue;
      }
      merged.push({ kind: "text", body: s.body.replace(/\n{3,}/g, "\n\n").trim() });
    } else {
      merged.push(s);
    }
  }
  return merged.filter((s) => (s.kind === "text" ? s.body.length > 0 : true));
}

/** 给 UI 用的工具名 / 参数概要 —— 不可解析时回退到一段截断文字 */
export function describeToolCall(seg: Extract<ToolCallSegment, { kind: "tool_call" }>): {
  tool: string;
  paramKeys: string[];
  preview: string;
} {
  const parsed = seg.parsed;
  const tool = (parsed?.tool || parsed?.name || "tool_call").toString();
  const params =
    (parsed?.params && typeof parsed.params === "object" ? parsed.params : null) ||
    (parsed?.arguments && typeof parsed.arguments === "object" ? parsed.arguments : null) ||
    {};
  const paramKeys = Object.keys(params).slice(0, 5);
  const preview = (() => {
    if (!parsed) {
      const t = seg.raw.trim().replace(/\s+/g, " ");
      return t.length > 120 ? `${t.slice(0, 120)}…` : t;
    }
    if (paramKeys.length === 0) return "（无参数）";
    return paramKeys.join(", ");
  })();
  return { tool, paramKeys, preview };
}
