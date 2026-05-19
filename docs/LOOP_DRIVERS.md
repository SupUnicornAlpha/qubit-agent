# Loop 驱动说明

QUBIT 将「**用什么运行时跑 Agent**」与「**Native 下走 Graph 还是 A2A 总线**」分成两个正交维度。

## Loop Kind（`workflow_run.loop_kind`）

| 值 | 驱动类 | 行为 |
|----|--------|------|
| `native`（默认） | `NativeLoopDriver` / `A2ALoopDriver` | 进程内 ReAct（`executeAgentReact`）或 A2A 派发 |
| `claude_cli` | `ClaudeCliLoopDriver` | 子进程 Claude CLI，行协议 → SSE |
| `codex_cli` | `CodexCliLoopDriver` | 子进程 Codex CLI |

CLI 循环不区分 `executionPath`，解析时按 graph 等价处理。

注册表：`src/runtime/loop/registry.ts` → `getLoopDriver(kind)`。

## Execution Path（仅 `loopKind = native`）

| 值 | 入口 | 说明 |
|----|------|------|
| `graph`（默认） | `graphRunner.runRoleTask` | 直接 `executeAgentReact`，`streamSource: native` |
| `a2a` | `a2aLoopDriver` → `TASK_ASSIGN` → `runA2aReactTaskAssign` | 同一 ReAct，经 A2A 消息与 `TASK_RESULT` 返回 |

解析顺序（`resolve-execution-path.ts`）：

1. 非 native → 固定 `graph`
2. `loopOptionsJson.executionPath`
3. `workflow_run.execution_path`
4. 环境变量 `QUBIT_AGENT_EXECUTION_PATH`

派发汇总见 `dispatchTaskToRole()`（`agent-pool.ts`）。

## loopOptionsJson 常用字段

| 字段 | 作用 |
|------|------|
| `executionPath` | 覆盖 workflow 上的 path |
| `reactLoop` | `false` 强制 ReAct 单轮（仍走四阶段一次） |
| `command` / `extraArgs` / `timeoutMs` | CLI 子进程 |
| `injectMcpBridge` | CLI 运行目录注入 MCP manifest |

类型定义：`src/types/loop.ts`。

## ReAct 多轮

内建循环始终为 **perceive → reason → act → observe**。  
是否在 observe 后回到 reason 由 `resolveForceReactLoop()` 决定，默认 **`maxIterations > 1`**（见 `react-loop-policy.ts`）。

更完整的架构上下文见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
