#!/usr/bin/env bun
/**
 * 批量启动多场景 workflow，用于 token 消耗基准测试。
 * 用法: bun run scripts/batch-token-benchmark.ts [--launch-only | --report-only]
 */

const API = process.env.QUBIT_API ?? "http://localhost:3000/api/v1";
const PROJECT_ID =
  process.env.QUBIT_PROJECT_ID ?? "00000000-0000-4000-8000-localproj0001";

interface ScenarioBench {
  key: string;
  label: string;
  agentGroupId: string;
  goal: string;
  analystBody: Record<string, unknown>;
}

const SCENARIOS: ScenarioBench[] = [
  {
    key: "research_single",
    label: "单标的调研",
    agentGroupId: "grp-full-analyst-team",
    goal: "[bench-pro] 单标的深度调研 · MSFT",
    analystBody: {
      ticker: "MSFT",
      context: "基准测试：对 MSFT 做单只深度研究，覆盖估值/财报/技术/宏观。",
      hitlMode: "off",
    },
  },
  {
    key: "research_multi",
    label: "多标的同业对比",
    agentGroupId: "grp-full-analyst-team",
    goal: "[bench-pro] 多标的同业 · NVDA/AMD/INTC",
    analystBody: {
      scope: { kind: "explore", theme: "NVDA / AMD / INTC 半导体横向对比" },
      context: "基准测试：三只半导体股横向对比，各输出多空观点。",
      hitlMode: "off",
    },
  },
  {
    key: "research_theme",
    label: "主题/行业调研",
    agentGroupId: "grp-full-analyst-team",
    goal: "[bench-pro] 主题调研 · AI算力基础设施",
    analystBody: {
      scope: { kind: "explore", theme: "AI算力基础设施 · 3个细分赛道+龙头标的" },
      context: "基准测试：主题驱动，自主识别赛道与龙头。",
      hitlMode: "off",
    },
  },
  {
    key: "stock_pick",
    label: "选股推荐",
    agentGroupId: "grp-stock-screening",
    goal: "[bench-pro] 选股 · 美股动量+估值",
    analystBody: {
      scope: { kind: "explore", theme: "美股大盘 momentum+估值 long 选股" },
      context: "基准测试：筛 3-5 只 long 候选并给理由。",
      hitlMode: "off",
    },
  },
  {
    key: "factor_research",
    label: "因子研究",
    agentGroupId: "grp-factor-research",
    goal: "[bench-pro] 因子研究 · 动量因子",
    analystBody: {
      scope: { kind: "explore", theme: "动量 alpha 因子设计 + IC/IR 评估" },
      context: "基准测试：提出动量因子公式+经济学解释+IC/IR。",
      hitlMode: "off",
    },
  },
  {
    key: "strategy_authoring",
    label: "策略生成",
    agentGroupId: "grp-strategy-pipeline",
    goal: "[bench-pro] 策略撰写 · TSLA趋势",
    analystBody: {
      ticker: "TSLA",
      context: "基准测试：产出可回测趋势策略草稿+回测假设。",
      hitlMode: "off",
    },
  },
  {
    key: "strategy_long_short",
    label: "多空策略",
    agentGroupId: "grp-strategy-pipeline",
    goal: "[bench-pro] 多空配对策略",
    analystBody: {
      scope: { kind: "explore", theme: "long/short 配对策略 · 因子组合+仓位约束" },
      context: "基准测试：long/short 配对策略，含 universe 与仓位上限。",
      hitlMode: "off",
    },
  },
  {
    key: "rule_research",
    label: "规则研究",
    agentGroupId: "grp-rule-research",
    goal: "[bench-pro] 规则研究 · JSON-DSL",
    analystBody: {
      scope: { kind: "explore", theme: "基于因子库生成可解释 JSON-DSL 规则" },
      context: "基准测试：生成可解释规则并入库。",
      hitlMode: "off",
    },
  },
  {
    key: "risk_review",
    label: "风控审查",
    agentGroupId: "grp-risk-review",
    goal: "[bench-pro] 风控审查",
    analystBody: {
      scope: { kind: "explore", theme: "审查策略历史与限额，产出风控规则建议" },
      context: "基准测试：风控审查+规则建议。",
      hitlMode: "off",
    },
  },
  {
    key: "analyst_debate",
    label: "分析辩论",
    agentGroupId: "grp-full-analyst-team",
    goal: "[bench-pro] 分析辩论 · GOOGL",
    analystBody: {
      ticker: "GOOGL",
      context: "基准测试：四维分析师 MSA + 多空辩论，输出融合信号。",
      hitlMode: "off",
    },
  },
];

interface LaunchedRun {
  scenarioKey: string;
  label: string;
  workflowRunId: string;
  jobId?: string;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function launchAll(): Promise<LaunchedRun[]> {
  const launched: LaunchedRun[] = [];
  for (const s of SCENARIOS) {
    console.log(`[launch] ${s.label} (${s.key})...`);
    const wf = await apiPost<{ data: { id: string } }>("/workflows", {
      projectId: PROJECT_ID,
      goal: s.goal,
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "react",
      loopOptionsJson: { maxIterations: 6, hitlMode: "off", roleReasoner: "native" },
    });
    const workflowRunId = wf.data.id;

    const job = await apiPost<{ jobId: string }>("/analyst/run", {
      workflowRunId,
      agentGroupId: s.agentGroupId,
      ...s.analystBody,
      roleReasoner: "native",
    });

    launched.push({
      scenarioKey: s.key,
      label: s.label,
      workflowRunId,
      jobId: job.jobId,
    });
    console.log(`  -> workflow=${workflowRunId.slice(0, 8)} job=${job.jobId?.slice(0, 8)}`);
    await Bun.sleep(800);
  }
  return launched;
}

async function waitAndReport(
  runs: LaunchedRun[],
  timeoutMs = 20 * 60_000,
  pollMs = 5000
): Promise<void> {
  const pending = new Set(runs.map((r) => r.workflowRunId));
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const id of [...pending]) {
      const res = await fetch(`${API}/workflows/${id}`);
      const json = (await res.json()) as { data?: { status: string } };
      const status = json.data?.status;
      if (status && ["completed", "failed", "cancelled", "timeout"].includes(status)) {
        pending.delete(id);
        const run = runs.find((r) => r.workflowRunId === id)!;
        console.log(`[done] ${run.label}: ${status}`);
      }
    }
    if (pending.size > 0) {
      console.log(`[poll] ${pending.size} still running...`);
      await Bun.sleep(pollMs);
    }
  }
  if (pending.size > 0) {
    console.log(`[timeout] ${pending.size} workflows still running after ${timeoutMs / 60000}min`);
  }
  await printReport(runs);
}

async function printReport(runs: LaunchedRun[]): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const dbPath =
    process.env.QUBIT_DATA_DIR
      ? `${process.env.QUBIT_DATA_DIR}/db/core.sqlite`
      : `${process.env.HOME}/.quant-agent/db/core.sqlite`;
  const db = new Database(dbPath, { readonly: true });

  const stmt = db.prepare(`
    SELECT wr.id, wr.status, wr.goal,
      COALESCE((SELECT SUM(total_tokens) FROM llm_call_log WHERE workflow_run_id = wr.id), 0) AS total_tokens,
      COALESCE((SELECT SUM(prompt_tokens) FROM llm_call_log WHERE workflow_run_id = wr.id), 0) AS prompt_tokens,
      COALESCE((SELECT SUM(completion_tokens) FROM llm_call_log WHERE workflow_run_id = wr.id), 0) AS completion_tokens,
      COALESCE((SELECT COUNT(*) FROM llm_call_log WHERE workflow_run_id = wr.id), 0) AS llm_calls,
      (SELECT provider || '/' || model FROM llm_call_log WHERE workflow_run_id = wr.id LIMIT 1) AS model
    FROM workflow_run wr WHERE wr.id = ?
  `);

  console.log("\n=== Token Benchmark Report ===\n");
  let grandTotal = 0;
  const rows: Array<{
    label: string;
    key: string;
    status: string;
    tokens: number;
    prompt: number;
    completion: number;
    calls: number;
    model: string;
  }> = [];

  for (const run of runs) {
    const row = stmt.get(run.workflowRunId) as {
      status: string;
      total_tokens: number;
      prompt_tokens: number;
      completion_tokens: number;
      llm_calls: number;
      model: string | null;
    };
    const tokens = Number(row?.total_tokens ?? 0);
    grandTotal += tokens;
    rows.push({
      label: run.label,
      key: run.scenarioKey,
      status: row?.status ?? "?",
      tokens,
      prompt: Number(row?.prompt_tokens ?? 0),
      completion: Number(row?.completion_tokens ?? 0),
      calls: Number(row?.llm_calls ?? 0),
      model: row?.model ?? "n/a",
    });
  }

  rows.sort((a, b) => b.tokens - a.tokens);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(16)} ${r.status.padEnd(10)} ${String(Math.round(r.tokens / 1000)).padStart(5)}k  ` +
        `in=${Math.round(r.prompt / 1000)}k out=${Math.round(r.completion / 1000)}k  calls=${r.calls}  ${r.model}`
    );
  }

  const completed = rows.filter((r) => r.status === "completed");
  const avg = completed.length ? completed.reduce((s, r) => s + r.tokens, 0) / completed.length : 0;
  console.log(`\nTotal: ${Math.round(grandTotal / 1000)}k | Completed avg: ${Math.round(avg / 1000)}k (${completed.length}/${rows.length})`);

  // Cost projection for different models (same token count)
  const inRatio = grandTotal > 0 ? rows.reduce((s, r) => s + r.prompt, 0) / grandTotal : 0.95;
  const prices = {
    "deepseek-v4-flash": { in: 0.14, out: 0.28 },
    "deepseek-v4-pro": { in: 0.435, out: 0.87 },
    "opus-4.8": { in: 5.0, out: 25.0 },
    "gpt-5.5": { in: 5.0, out: 30.0 },
  };
  console.log("\n=== Cost for this batch (same tokens, different models) ===");
  for (const [name, p] of Object.entries(prices)) {
    let cost = 0;
    for (const r of rows) {
      const tin = r.prompt || r.tokens * inRatio;
      const tout = r.completion || r.tokens * (1 - inRatio);
      cost += (tin * p.in + tout * p.out) / 1e6;
    }
    console.log(`  ${name.padEnd(20)} $${cost.toFixed(2)}`);
  }

  db.close();
}

async function main() {
  const mode = process.argv[2] ?? "full";
  const outFile = `${import.meta.dir}/../out/batch-benchmark-pro-runs.json`;

  if (mode === "--report-only") {
    const runs = JSON.parse(await Bun.file(outFile).text()) as LaunchedRun[];
    await printReport(runs);
    return;
  }

  const runs = await launchAll();
  await Bun.write(outFile, JSON.stringify(runs, null, 2));
  console.log(`\nSaved run IDs to ${outFile}`);

  if (mode !== "--launch-only") {
    await waitAndReport(runs);
  } else {
    console.log("Launch-only mode. Run with --report-only later.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
