/**
 * Host-side Turn Packet — model-visible context without UI/trace pollution.
 *
 * Full chat + tool traces stay in SQLite/UI. Only a short chronicle feeds Core.
 * Display copy / i18n never belongs here (or in Core).
 */

export type TranscriptMessage = {
  id: string;
  role: string;
  sender?: string | null;
  content: string;
};

export type RecentToolLine = {
  toolName: string;
  /** Short status: ok | fail | unknown */
  status: "ok" | "fail" | "unknown";
  detail?: string;
};

export type BuildSessionChronicleInput = {
  messages: TranscriptMessage[];
  currentUserMessageId: string;
  currentUserText: string;
  recentTools?: RecentToolLine[];
  /** Max prior turns (user+assistant pairs approx). Default 8 messages. */
  maxMessages?: number;
  /**
   * Rolling compacted head from prior turns (Host-persisted). Folded older
   * overflow is merged into this so long sessions stay bounded.
   */
  priorCompactedSummary?: string | null;
};

/** Persistable rolling chronicle (loop_options_json.sessionChronicle). */
export type RollingChronicleState = {
  version: number;
  /** Folded older turns (one-line summaries). */
  compactedSummary: string;
  /** Newest message ids already absorbed into compactedSummary or live window. */
  absorbedMessageIds: string[];
};

export function emptyRollingChronicle(): RollingChronicleState {
  return { version: 1, compactedSummary: "", absorbedMessageIds: [] };
}

export function parseRollingChronicle(raw: unknown): RollingChronicleState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyRollingChronicle();
  }
  const o = raw as Record<string, unknown>;
  const compactedSummary =
    typeof o.compactedSummary === "string" ? o.compactedSummary : "";
  const absorbedMessageIds = Array.isArray(o.absorbedMessageIds)
    ? o.absorbedMessageIds.filter((x): x is string => typeof x === "string")
    : [];
  const version = typeof o.version === "number" && o.version > 0 ? o.version : 1;
  return { version, compactedSummary, absorbedMessageIds: absorbedMessageIds.slice(-64) };
}

/**
 * Fold overflow messages into compactedSummary; keep a live window of maxEntries.
 * Returns updated state + priorCompactedSummary for render.
 */
export function rollChronicleWindow(input: {
  state: RollingChronicleState;
  messages: TranscriptMessage[];
  currentUserMessageId: string;
  maxEntries?: number;
}): { state: RollingChronicleState; priorCompactedSummary: string } {
  const maxEntries = input.maxEntries ?? 8;
  const prior = input.messages.filter(
    (m) =>
      m.id !== input.currentUserMessageId &&
      m.content.trim().length > 0 &&
      m.role !== "system"
  );
  const absorbed = new Set(input.state.absorbedMessageIds);
  let compacted = input.state.compactedSummary.trim();

  if (prior.length > maxEntries) {
    const overflow = prior.slice(0, prior.length - maxEntries);
    const freshOverflow = overflow.filter((m) => !absorbed.has(m.id));
    if (freshOverflow.length > 0) {
      const chunk = freshOverflow
        .map((m) => {
          if (m.role === "user") {
            return `user:${summarizeUserForChronicle(m.content, 120)}`;
          }
          return `asst:${summarizeAssistantForChronicle(m.content, 100)}`;
        })
        .join(" · ");
      compacted = [compacted, chunk].filter(Boolean).join(" | ").slice(0, 1400);
      for (const m of freshOverflow) absorbed.add(m.id);
    }
  }

  const window = prior.slice(-maxEntries);
  for (const m of window) absorbed.add(m.id);

  return {
    state: {
      version: input.state.version + (compacted !== input.state.compactedSummary ? 1 : 0),
      compactedSummary: compacted,
      absorbedMessageIds: Array.from(absorbed).slice(-64),
    },
    priorCompactedSummary: compacted,
  };
}

const DELIVERY_MARKERS: RegExp[] = [
  /人肉(操盘)?说明书/,
  /人肉版/,
  /看盘手册/,
  /自然语言描述/,
  /操盘说明书/,
  /完整版\)/,
  /📖/,
  /#{1,3}\s*`[^`]+`\s*[—\-–].*说明/,
  /Factor\s*[①1]\s*[:：]/i,
];

const TASK_SUPERSEDE_MARKERS: RegExp[] = [
  /不是要人肉/,
  /不要人肉/,
  /不要说明书/,
  /不要文档/,
  /别给我说明书/,
  /别再给我.*说明/,
  /帮我选股/,
  /去选股/,
  /我要你帮我选股/,
  /给我选\d*个/,
];

export function isDeliveryNarrative(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  let hits = 0;
  for (const re of DELIVERY_MARKERS) {
    if (re.test(t)) hits += 1;
  }
  // Long markdown with many headings often = prior delivery artifact
  if (t.length > 1200) {
    const headings = (t.match(/^#{1,3}\s+/gm) ?? []).length;
    if (headings >= 4) hits += 1;
  }
  return hits >= 1;
}

export function extractDeliveryTitle(text: string): string {
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  if (heading?.[1]) return heading[1].replace(/[*_`]/g, "").trim().slice(0, 120);
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (first ?? "prior_delivery").slice(0, 120);
}

export function summarizeAssistantForChronicle(content: string, maxLen = 160): string {
  const t = content.trim();
  if (!t) return "(empty)";
  if (isDeliveryNarrative(t)) {
    return `[delivered_artifact] ${extractDeliveryTitle(t)} (full text omitted; do not regenerate unless user asks)`;
  }
  return t.replace(/\s+/g, " ").slice(0, maxLen);
}

export function summarizeUserForChronicle(content: string, maxLen = 220): string {
  return content.trim().replace(/\s+/g, " ").slice(0, maxLen);
}

export function detectTaskSupersession(
  priorMessages: TranscriptMessage[],
  currentUserText: string
): string | null {
  const user = currentUserText.trim();
  if (!user) return null;
  const rejectsPrior = TASK_SUPERSEDE_MARKERS.some((re) => re.test(user));
  if (!rejectsPrior) return null;
  const hadDelivery = priorMessages.some(
    (m) => m.role !== "user" && isDeliveryNarrative(m.content)
  );
  if (!hadDelivery) return null;
  return [
    "TASK_SUPERSESSION: earlier assistant turns produced explanatory manuals (delivered_artifact).",
    "User superseded that mode. Do NOT regenerate manuals / 人肉说明书.",
    "Execute CURRENT_USER_TASK only (e.g. stock picking / screening with tools + evidence).",
  ].join(" ");
}

function wrapBackground(label: string, body: string): string {
  const b = body.trim();
  if (!b) return "";
  return `OPTIONAL_BACKGROUND (${label}) — do NOT override CURRENT_USER_TASK:\n${b}`;
}

/**
 * Build Host chronicle string for params.context (feeds Core as background).
 * Never includes full prior delivery prose.
 */
export function buildSessionChronicle(input: BuildSessionChronicleInput): string {
  const maxMessages = input.maxMessages ?? 8;
  const allPrior = input.messages.filter(
    (m) =>
      m.id !== input.currentUserMessageId &&
      m.content.trim().length > 0 &&
      m.role !== "system"
  );

  let compactedHead = (input.priorCompactedSummary ?? "").trim();
  let prior = allPrior;
  if (allPrior.length > maxMessages) {
    const overflow = allPrior.slice(0, allPrior.length - maxMessages);
    prior = allPrior.slice(-maxMessages);
    const overflowLine = overflow
      .map((m) =>
        m.role === "user"
          ? `user:${summarizeUserForChronicle(m.content, 100)}`
          : `asst:${summarizeAssistantForChronicle(m.content, 80)}`
      )
      .join(" · ")
      .slice(0, 800);
    compactedHead = [compactedHead, overflowLine].filter(Boolean).join(" | ").slice(0, 1400);
  }

  const lines: string[] = [];
  if (compactedHead) {
    lines.push(`- [compacted_prior] ${compactedHead}`);
  }
  for (const m of prior) {
    if (m.role === "user") {
      lines.push(`- user: ${summarizeUserForChronicle(m.content)}`);
    } else {
      const who = (m.sender ?? "assistant").trim() || "assistant";
      lines.push(`- ${who}: ${summarizeAssistantForChronicle(m.content)}`);
    }
  }

  const sections: string[] = [];
  const supersession = detectTaskSupersession(allPrior, input.currentUserText);
  if (supersession) {
    sections.push(supersession);
  }

  if (lines.length > 0) {
    sections.push(
      wrapBackground(
        "session_chronicle",
        ["## Session chronicle (compressed; full UI transcript retained elsewhere)", ...lines].join(
          "\n"
        )
      )
    );
  }

  if (input.recentTools && input.recentTools.length > 0) {
    const toolLines = input.recentTools.slice(0, 12).map((t) => {
      const det = t.detail ? ` — ${t.detail.slice(0, 80)}` : "";
      return `- ${t.toolName}: ${t.status}${det}`;
    });
    sections.push(
      wrapBackground(
        "recent_tools",
        ["## Recent tool outcomes (stubs)", ...toolLines].join("\n")
      )
    );
  }

  if (sections.length === 0) {
    return wrapBackground("session_chronicle", "(no prior session chronicle)");
  }
  return sections.join("\n\n");
}

/** Merge workspace pack (already Host text) as background; keep short. */
export function mergeWorkspaceBackground(
  chronicle: string,
  workspaceContextBlock: string | null | undefined,
  maxChars = 2200
): string {
  const ws = (workspaceContextBlock ?? "").trim();
  if (!ws) return chronicle;
  const clipped = ws.length > maxChars ? `${ws.slice(0, maxChars - 1)}…` : ws;
  const wsBlock = wrapBackground("workspace", clipped);
  return chronicle.trim() ? `${wsBlock}\n\n${chronicle}` : wsBlock;
}

/** Infer tool status from interaction content_text / payload. */
export function inferToolStatus(contentText: string, payload?: Record<string, unknown>): RecentToolLine["status"] {
  const raw = `${contentText} ${JSON.stringify(payload ?? {})}`.toLowerCase();
  if (
    /\bfail(ed|ure)?\b/.test(raw) ||
    /失败/.test(contentText) ||
    /error/.test(raw) ||
    raw.includes('"ok":false') ||
    raw.includes('"success":false')
  ) {
    return "fail";
  }
  if (
    /\bok\b/.test(raw) ||
    /成功/.test(contentText) ||
    raw.includes('"ok":true') ||
    raw.includes('"success":true')
  ) {
    return "ok";
  }
  return "unknown";
}
