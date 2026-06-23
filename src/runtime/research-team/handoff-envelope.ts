/**
 * 跨 Agent 交接信封（handoff envelope）的运行时解析 + 归一化。
 *
 * 背景（docs/CODING_AGENT_EXPERIENCE_DESIGN.md）：团队统一报告协议（ANALYST_REPORT_PROTOCOL）
 * 要求每个专家在输出里附一段机器可读的 JSON 信封（thesis / falsifiers / handoffs / metrics /
 * data_refs / extensions ...）。本模块把它从「提示词约定」升级为「运行时结构化」——
 * 在 slot 落库时解析 + 归一化，写进 interaction 的 payloadJson.handoff，让下游（Orchestrator /
 * research / backtest / risk / 前端）**程序化消费**而不必再去正文里捞数字。
 *
 * 设计原则：**永远防御性**——LLM 给的 JSON 形状不稳定，任何字段缺失/类型错误都安静降级，
 * 绝不抛错阻塞主流程。解析不到有意义内容返回 null。
 */

/** 金融重点数据的结构化条目：值 + 单位 + 数据时点 + 来源。 */
export interface HandoffMetric {
  name: string;
  value: number | string;
  unit?: string;
  asof?: string;
  source?: string;
}

/** 大数据指针：传 id 不内联（factor / strategy_version / backtest_run / order_intent / dataset / report）。 */
export interface HandoffDataRef {
  kind: string;
  id: string;
  note?: string;
}

/** 给其他角色的交接请求。 */
export interface HandoffAsk {
  role: string;
  ask: string;
}

export interface HandoffEnvelope {
  thesis?: string;
  falsifiers?: string[];
  open_questions?: string[];
  handoffs?: HandoffAsk[];
  metrics?: HandoffMetric[];
  data_refs?: HandoffDataRef[];
  extensions?: Record<string, unknown>;
}

const ENVELOPE_KEYS = [
  "thesis",
  "falsifiers",
  "open_questions",
  "handoffs",
  "metrics",
  "data_refs",
  "extensions",
] as const;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** 容错成 string[]：数组逐项 String 化并过滤空；单个 string 包成单元素数组。 */
function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 0);
    return out.length > 0 ? out : undefined;
  }
  const s = asString(v);
  return s ? [s] : undefined;
}

function normalizeHandoffs(v: unknown): HandoffAsk[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: HandoffAsk[] = [];
  for (const item of v) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const role = asString(o.role) ?? asString(o.to) ?? asString(o.target);
      const ask = asString(o.ask) ?? asString(o.request) ?? asString(o.task);
      if (role && ask) out.push({ role, ask });
    } else {
      // 容错：字符串如 "@analyst_macro 确认利率路径"
      const s = asString(item);
      const m = s?.match(/@?([a-z_]+)\s+(.+)/i);
      if (m?.[1] && m[2]) out.push({ role: m[1], ask: m[2].trim() });
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeMetrics(v: unknown): HandoffMetric[] | undefined {
  const out: HandoffMetric[] = [];
  const pushEntry = (name: string, raw: unknown): void => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      const value = o.value;
      if (typeof value === "number" || typeof value === "string") {
        out.push({
          name,
          value,
          ...(asString(o.unit) ? { unit: asString(o.unit) } : {}),
          ...(asString(o.asof) ? { asof: asString(o.asof) } : {}),
          ...(asString(o.source) ? { source: asString(o.source) } : {}),
        });
      }
    } else if (typeof raw === "number" || typeof raw === "string") {
      out.push({ name, value: raw });
    }
  };
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const o = item as Record<string, unknown>;
        const name = asString(o.name) ?? asString(o.metric) ?? asString(o.key);
        if (!name) continue;
        pushEntry(name, o);
      }
    }
  } else if (v && typeof v === "object") {
    // 容错：metrics 写成 map {pe: 12.3, rank_ic: 0.05} 或 {pe:{value,unit}}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) pushEntry(k, val);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeDataRefs(v: unknown): HandoffDataRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: HandoffDataRef[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const kind = asString(o.kind) ?? asString(o.type);
    const id = asString(o.id) ?? asString(o.ref) ?? asString(o.value);
    if (kind && id) out.push({ kind, id, ...(asString(o.note) ? { note: asString(o.note) } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** 抽取候选信封对象：优先文本中**最后一个** ```json fenced 块；否则扫含信封键的平衡 {…}。 */
function extractEnvelopeObject(text: string): Record<string, unknown> | null {
  // 1) fenced ```json ... ```（取最后一个，通常是报告末尾的交接信封）
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  const fences: string[] = [];
  let m: RegExpExecArray | null = fenceRe.exec(text);
  while (m) {
    if (m[1]) fences.push(m[1]);
    m = fenceRe.exec(text);
  }
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(fences[i]?.trim() ?? "");
      if (obj && typeof obj === "object" && !Array.isArray(obj))
        return obj as Record<string, unknown>;
    } catch {
      // 下一个候选
    }
  }
  // 2) 扫描平衡 {…}，取含信封键的最后一个
  const candidates: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              const o = obj as Record<string, unknown>;
              if (ENVELOPE_KEYS.some((k) => k in o)) candidates.push(o);
            }
          } catch {
            // ignore
          }
          break;
        }
      }
    }
  }
  return candidates.length > 0 ? (candidates[candidates.length - 1] ?? null) : null;
}

/**
 * 解析 + 归一化交接信封。
 * @param input 可为原始输出文本（markdown 角色，含末尾 ```json``` 块）或已解析对象（analyst structured）。
 * @returns 归一化后的信封；无任何有意义字段时返回 null。
 */
export function parseHandoffEnvelope(
  input: string | Record<string, unknown> | null | undefined
): HandoffEnvelope | null {
  if (input == null) return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof input === "string") {
    obj = extractEnvelopeObject(input);
  } else if (typeof input === "object" && !Array.isArray(input)) {
    obj = input;
  }
  if (!obj) return null;

  const env: HandoffEnvelope = {};
  const thesis = asString(obj.thesis);
  if (thesis) env.thesis = thesis.slice(0, 500);
  const falsifiers = asStringArray(obj.falsifiers);
  if (falsifiers) env.falsifiers = falsifiers.slice(0, 10);
  const openQ = asStringArray(obj.open_questions);
  if (openQ) env.open_questions = openQ.slice(0, 10);
  const handoffs = normalizeHandoffs(obj.handoffs);
  if (handoffs) env.handoffs = handoffs.slice(0, 10);
  const metrics = normalizeMetrics(obj.metrics);
  if (metrics) env.metrics = metrics.slice(0, 40);
  const dataRefs = normalizeDataRefs(obj.data_refs);
  if (dataRefs) env.data_refs = dataRefs.slice(0, 20);
  if (obj.extensions && typeof obj.extensions === "object" && !Array.isArray(obj.extensions)) {
    env.extensions = obj.extensions as Record<string, unknown>;
  }

  return Object.keys(env).length > 0 ? env : null;
}
