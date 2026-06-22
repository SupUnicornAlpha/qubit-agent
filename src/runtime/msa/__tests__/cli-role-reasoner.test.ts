import { describe, expect, test } from "bun:test";
import {
  QUBIT_BRIDGE_TOOL,
  buildRoleCliInvocation,
  buildRolePromptText,
  extractModelFromProvider,
  parseClaudeStreamJsonFinal,
  parseCodexSessionId,
} from "../cli-role-reasoner";
import type { RoleReasonRequest } from "../role-reasoner";

const baseInvocation = {
  systemPrompt: "你是基本面分析师",
  bridgeManifestPath: "/run/qubit-mcp-bridge.json",
  bridgeEntryFile: "/abs/mcp-bridge-server.ts",
  projectId: "proj-1",
  lastMessagePath: "/run/last-message.txt",
};

describe("buildRoleCliInvocation — claude", () => {
  test("注入 stream-json / mcp-config / allowedTools / append-system-prompt", () => {
    const { command, args } = buildRoleCliInvocation({ kind: "claude_cli", ...baseInvocation });
    expect(command).toBe("claude");
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/run/qubit-mcp-bridge.json");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--allowedTools");
    expect(args).toContain(QUBIT_BRIDGE_TOOL);
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("你是基本面分析师");
  });

  test("model 透传 + resume 前置", () => {
    const { args } = buildRoleCliInvocation({
      kind: "claude_cli",
      ...baseInvocation,
      model: "claude-opus-4-8",
      resumeSessionId: "sess-9",
    });
    expect(args.slice(0, 2)).toEqual(["--resume", "sess-9"]);
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-8");
  });
});

describe("buildRoleCliInvocation — codex", () => {
  test("exec --json -o + mcp_servers.qubit 三段 -c 注入", () => {
    const { command, args } = buildRoleCliInvocation({ kind: "codex_cli", ...baseInvocation });
    expect(command).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("-o");
    expect(args).toContain("/run/last-message.txt");
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.qubit.command=bun");
    expect(joined).toContain('mcp_servers.qubit.args=["run","/abs/mcp-bridge-server.ts"]');
    expect(joined).toContain("mcp_servers.qubit.env.QUBIT_MCP_BRIDGE_PROJECT_ID=proj-1");
  });

  test("resume 作为 exec 子命令插入", () => {
    const { args } = buildRoleCliInvocation({
      kind: "codex_cli",
      ...baseInvocation,
      resumeSessionId: "sess-c",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "sess-c"]);
  });
});

describe("extractModelFromProvider", () => {
  test("仅 provider 与 CLI 匹配时透传", () => {
    expect(extractModelFromProvider("anthropic:claude-opus-4-8", "claude_cli")).toBe(
      "claude-opus-4-8"
    );
    expect(extractModelFromProvider("openai:gpt-4o", "codex_cli")).toBe("gpt-4o");
    // 不匹配 → 让 CLI 用默认
    expect(extractModelFromProvider("openai:gpt-4o", "claude_cli")).toBeUndefined();
    expect(extractModelFromProvider("deepseek:deepseek-chat", "codex_cli")).toBeUndefined();
    expect(extractModelFromProvider("anthropic", "claude_cli")).toBeUndefined();
  });
});

describe("parseClaudeStreamJsonFinal", () => {
  test("取 result 事件文本 + 嗅探 session_id", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-abc","tools":[]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"思考中"}]},"session_id":"sess-abc"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"signal\\":\\"buy\\"}","session_id":"sess-abc"}',
    ].join("\n");
    const out = parseClaudeStreamJsonFinal(stdout);
    expect(out.text).toBe('{"signal":"buy"}');
    expect(out.sessionId).toBe("sess-abc");
  });

  test("无 result 事件时回退拼接 assistant 文本", () => {
    const stdout = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"part-1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"part-2"}]}}',
    ].join("\n");
    const out = parseClaudeStreamJsonFinal(stdout);
    expect(out.text).toBe("part-1\npart-2");
    expect(out.sessionId).toBeUndefined();
  });

  test("忽略非 JSON 噪声行", () => {
    const stdout = ["some stderr-ish noise leaked", '{"type":"result","result":"ok"}'].join("\n");
    expect(parseClaudeStreamJsonFinal(stdout).text).toBe("ok");
  });
});

describe("parseCodexSessionId", () => {
  test("从 JSONL 事件嗅探 session_id", () => {
    const stdout = [
      '{"type":"session_configured","session_id":"codex-sess-1"}',
      '{"type":"item.completed"}',
    ].join("\n");
    expect(parseCodexSessionId(stdout)).toBe("codex-sess-1");
  });

  test("无则返回 undefined", () => {
    expect(parseCodexSessionId('{"type":"foo"}')).toBeUndefined();
  });
});

describe("buildRolePromptText", () => {
  const req: RoleReasonRequest = {
    def: {
      id: "d1",
      role: "analyst_fundamental",
      name: "基本面",
      version: "1",
      systemPrompt: "ROLE-SYS-PROMPT",
      tools: [],
      mcpServers: [],
      skills: [],
      subscriptions: ["TASK_ASSIGN"],
      llmProvider: "anthropic:claude-opus-4-8",
      maxIterations: 4,
      sandboxPolicyId: "sb",
      enabled: true,
    },
    role: "analyst_fundamental",
    workflowRunId: "wf",
    runId: "r",
    traceId: "t",
    payload: {
      taskId: "r",
      taskType: "analyst_team_slot",
      assignedRole: "analyst_fundamental",
      params: {},
    },
    userGoal: "分析 NVDA",
    ticker: "NVDA",
    context: "CTX",
    expectJsonSignal: true,
  };

  test("claude 路径不前置 systemPrompt（走 --append-system-prompt）", () => {
    const txt = buildRolePromptText(req, false);
    expect(txt).not.toContain("ROLE-SYS-PROMPT");
    expect(txt).toContain("分析 NVDA");
    expect(txt).toContain("CTX");
    expect(txt).toContain("JSON 信号");
  });

  test("codex 路径前置 systemPrompt", () => {
    const txt = buildRolePromptText(req, true);
    expect(txt).toContain("ROLE-SYS-PROMPT");
  });

  test("expectJsonSignal=false → Markdown 收尾", () => {
    const txt = buildRolePromptText({ ...req, expectJsonSignal: false }, false);
    expect(txt).toContain("Markdown 小结");
  });

  test("skillsBlock 非空时注入；空串不注入", () => {
    const withSkills = buildRolePromptText(req, false, "## 相关 Skill\n动量因子步骤…");
    expect(withSkills).toContain("相关 Skill");
    expect(withSkills).toContain("动量因子步骤");
    // skills 在任务/上下文之后、可用工具之前
    expect(withSkills.indexOf("相关 Skill")).toBeLessThan(withSkills.indexOf("# 可用工具"));

    const noSkills = buildRolePromptText(req, false, "   ");
    expect(noSkills).not.toContain("相关 Skill");
  });
});
