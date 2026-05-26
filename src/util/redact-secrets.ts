/**
 * 通用密钥 / Token 剥除工具。
 *
 * 背景（详见 docs/MONITORING_V2_DESIGN.md §7.1 与 P1 探索报告）：
 * 监控 V2 要把 LLM 请求 / MCP 调用 / Connector 调用三类 payload 写到 SQLite。
 * 在引入这套工具前，仓库内**没有任何可复用的 redact helper**：
 *   - LLM gateway 直接把 `Authorization: Bearer <key>` 注入 HTTP header；
 *   - MCP dispatcher 把 `arguments` 裸落 `mcp_call_log.request_json`；
 *   - Connector 也是裸传 `caps.env`（含 broker secret）。
 *
 * 一旦把这些 payload 写进 SQLite，本地 sqlite 文件就成了二级密钥仓库；
 * 任意一次错误的 `db dump` 或日志导出都会泄漏 api_key / broker secret。
 *
 * 本模块提供两条出口（均为纯函数 / 无副作用 / 无 DB 依赖）：
 *   - `redactHeaders(headers)`：HTTP header 用，盖掉 Authorization / x-api-key / cookie 等。
 *   - `redactPayload(obj, opts)`：递归深拷贝并把疑似密钥字段值替换为 "***"。
 *
 * 设计要点：
 *   1) **白名单优先**：只盖已知密钥字段名（Authorization、api_key、apiKey、token、secret、password、cookie）；
 *      避免误盖业务字段。
 *   2) **不修改入参**：返回深拷贝结果，调用方仍可用原始对象做业务逻辑。
 *   3) **截断兜底**：超过 `opts.maxBytes`（默认 8192）的 JSON 序列化体直接截断尾巴，
 *      避免单条 mcp_call_log/request_json 把 sqlite 撑爆（一次完整 messages[] 可能 50KB+）。
 *   4) **无依赖**：纯 TS，可在 gateway / dispatcher / act / 后续 connector wrapper 中共享。
 */

/**
 * HTTP header 名（大小写不敏感）匹配到任一关键字就视为机密 header。
 * 顺序固定：扩展时优先加在尾部，便于 review diff 看变化。
 */
const SECRET_HEADER_KEYS: readonly string[] = [
  "authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "cookie",
  "set-cookie",
  "proxy-authorization",
];

/**
 * 对象 key（小写后）匹配到任一关键字（substring 匹配）就视为机密字段。
 *
 * 注意采用 substring 而非完全相等：很多 SDK 用 `apiKeyRef` / `openaiApiKey` /
 * `brokerSecret` 这类驼峰命名，substring 能一并覆盖；偶有误伤业务字段（如
 * `secret_seed_count` 之类）可在 caller 用 `opts.allowKeys` 显式豁免。
 */
const SECRET_OBJECT_KEY_PATTERNS: readonly string[] = [
  "apikey",
  "api_key",
  "secret",
  "password",
  "token",
  "authorization",
  "auth_token",
  "access_token",
  "refresh_token",
  "private_key",
  "credentials",
];

/** Header redact 结果占位字符串 — 与 OpenAI / Stripe 习惯保持一致。 */
const REDACTED = "***";

export type RedactPayloadOptions = {
  /**
   * 序列化后字节数（UTF-8 估算 byteLength）上限。
   * 超过将在尾部追加 `…[truncated N bytes]` 字符串。
   *
   * 默认 8192：覆盖 99% 的 LLM 单消息 / MCP arguments，但 prompt
   * 可能远超 — 监控用 truncated 已够定位问题；想看完整请求请去 agent_step.actionJson。
   */
  maxBytes?: number;
  /**
   * 即便 key 命中机密 pattern，仍允许保留这些 key 原值（小写比较）。
   * 例：业务确需展示 `apiKeyName`（而非 key 值本身）时传 ["apikeyname"]。
   */
  allowKeys?: readonly string[];
};

/**
 * 用于 HTTP header（fetch / undici / Node http）。
 *
 * 输入可以是：
 *   - `Record<string, string>` / `Record<string, string[]>`（Node 原生）
 *   - `Headers`（浏览器 / Bun fetch）
 *
 * 返回值统一为 `Record<string, string>`，便于直接 stringify 写入日志。
 * 多值 header 以 ", " 拼接，与 HTTP/1.1 RFC 7230 §3.2.2 处理一致。
 */
export function redactHeaders(
  headers:
    | Headers
    | Record<string, string | string[] | undefined>
    | undefined
    | null
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  const set = (k: string, v: string): void => {
    const lk = k.toLowerCase();
    out[k] = SECRET_HEADER_KEYS.some((s) => lk.includes(s)) ? REDACTED : v;
  };
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => set(key, value));
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  return out;
}

/**
 * 用于 LLM / MCP / Connector 请求 payload。
 *
 * 行为：
 *   1) 深拷贝（不修改入参）；
 *   2) 命中 SECRET_OBJECT_KEY_PATTERNS 的 key 值替换为 "***"；
 *   3) 数组 / 嵌套对象递归；循环引用回填 `[circular]`；
 *   4) 序列化超 `maxBytes` 在尾部追加 `…[truncated N bytes]`。
 *
 * 失败兜底：内部任何 throw 都返回 `{ _redact_error: <message> }`，
 * 保证调用方写 DB 路径不会被反查 / 序列化异常打断。
 */
export function redactPayload<T>(value: T, opts: RedactPayloadOptions = {}): unknown {
  try {
    const allow = new Set((opts.allowKeys ?? []).map((s) => s.toLowerCase()));
    const seen = new WeakSet<object>();
    const cloned = deepRedact(value, allow, seen);
    const max = opts.maxBytes ?? 8192;
    return truncateIfTooLarge(cloned, max);
  } catch (err) {
    return { _redact_error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 判断 key 是否应被剥除。导出仅供单测使用；线上路径请用 `redactPayload`。
 */
export function isSecretKey(key: string): boolean {
  const lk = key.toLowerCase();
  return SECRET_OBJECT_KEY_PATTERNS.some((s) => lk.includes(s));
}

function deepRedact(value: unknown, allow: Set<string>, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== "object" && t !== "function") return value;
  // function 等非 plain 直接丢成占位，避免 JSON.stringify 时变成 undefined 字段
  if (t === "function") return "[function]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => deepRedact(item, allow, seen));
  }
  // Buffer / TypedArray 等不展开（写监控库时按 base64 length 描述即可）
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    return `[binary:${(obj as ArrayBuffer).byteLength ?? (obj as ArrayBufferView).byteLength}]`;
  }
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Error) {
    return { name: obj.name, message: obj.message, stack: obj.stack?.slice(0, 800) ?? null };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(k) && !allow.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = deepRedact(v, allow, seen);
    }
  }
  return out;
}

function truncateIfTooLarge(value: unknown, maxBytes: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    // 仍有循环引用 / BigInt 等问题：退回简描述，让调用方仍能写库
    return { _redact_serialize_error: "JSON.stringify failed after redact" };
  }
  // 使用 Buffer.byteLength（如可用）以匹配 UTF-8 真实长度；
  // 浏览器环境 fallback 到 string length（保留近似上限即可）。
  const byteLength =
    typeof Buffer !== "undefined" ? Buffer.byteLength(json, "utf8") : json.length;
  if (byteLength <= maxBytes) return value;
  const head =
    typeof Buffer !== "undefined"
      ? Buffer.from(json, "utf8").slice(0, maxBytes - 64).toString("utf8")
      : json.slice(0, maxBytes - 64);
  return `${head}…[truncated ${byteLength - head.length} bytes]`;
}

export const __TEST_ONLY__ = {
  SECRET_HEADER_KEYS,
  SECRET_OBJECT_KEY_PATTERNS,
  REDACTED,
};
