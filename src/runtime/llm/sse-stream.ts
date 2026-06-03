/**
 * 极简 Server-Sent Events 解析器，用于 Anthropic Messages / OpenAI Responses 这
 * 类"行分隔 + 空行结尾"协议。专门做"够用"，不追求完整 SSE 规范覆盖。
 *
 * 协议要点（W3C SSE simple subset）：
 *   - 一个 event 由若干行组成，事件之间以 `\n\n`（双换行）分隔；
 *   - 每行格式 `key: value`；常见 key 是 `event`（事件名）和 `data`（payload，
 *     可能多行 concatenate 成 `\n` 拼接）；
 *   - 注释行以 `:` 开头，直接忽略。
 *
 * 设计：
 *   - 异步生成器：caller 用 `for await` 逐事件处理，背压自然由 reader.read() 控制；
 *   - 输入是 ReadableStream<Uint8Array>，不绑死 fetch / Bun 的具体实现；
 *   - 解码用 TextDecoder({ stream: true }) 处理多字节 UTF-8 跨 chunk 边界；
 *   - 不抛错：data 行没有时跳过，`data: [DONE]` 由 caller 自行判断。
 */

export interface SseEvent {
  /** 来自 `event:` 行；未给出时为 undefined（SSE 规范默认事件类型 'message'） */
  event?: string;
  /** 拼接后的 data payload；caller 自己 JSON.parse */
  data: string;
}

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      /**
       * 切块：以 `\n\n` 分割。注意有些上游（包括 Anthropic）会用 `\r\n\r\n`，
       * 先把 \r\n 规范成 \n 再切，避免漏切。
       */
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev) yield ev;
      }
    }
    /** 流末尾若残留半个事件块，尝试解一下；正常 SSE 不会发生，多一层兜底 */
    const tail = buf.trim();
    if (tail) {
      const ev = parseSseBlock(tail);
      if (ev) yield ev;
    }
  } finally {
    /** 显式 release：防止 caller break 出来时连接挂在 reader 上 */
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line) continue;
    /** 注释行（以 ':' 起头）：忽略。SSE 心跳常这么发：`:keepalive` */
    if (line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    const field = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
    /** 规范允许 `field:value` 与 `field: value`（吃掉首个空格）两种 */
    let val = colonIdx >= 0 ? line.slice(colonIdx + 1) : "";
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") {
      event = val;
    } else if (field === "data") {
      dataLines.push(val);
    }
    /** 其它 field（id / retry）暂不处理 */
  }
  if (dataLines.length === 0) return null;
  return { ...(event !== undefined ? { event } : {}), data: dataLines.join("\n") };
}
