# Loop 驱动说明

QUBIT 将「**用什么运行时跑 Agent**」收敛为一个主维度。Native 进程内运行时的内部总线已统一为 **A2A**；历史 `execution_path=graph` 仅作为 DB 兼容字段保留。

## Loop Kind（`workflow_run.loop_kind`）

| 值 | 驱动类 | 行为 |
|----|--------|------|
| `native`（默认） | `A2ALoopDriver` | 进程内 A2A 派发；角色任务最终进入 `executeAgentReact` |
| `claude_cli` | `ClaudeCliLoopDriver` | 子进程 Claude CLI，行协议 → SSE |
| `codex_cli` | `CodexCliLoopDriver` | 子进程 Codex CLI |

CLI 循环不区分 `executionPath`，解析时按 graph 占位值兼容旧字段。

注册表：`src/runtime/loop/registry.ts` → `getLoopDriver(kind)`。

## Execution Path（历史兼容字段）

| 值 | 当前行为 |
|----|----------|
| `graph` | 历史 DB 行兼容；native 下会被 `resolveExecutionPath()` 归一为 `a2a` |
| `a2a` | 当前唯一 native 内部总线：`a2aLoopDriver` → `TASK_ASSIGN` → `runA2aReactTaskAssign` → `executeAgentReact` |

解析规则（`resolve-execution-path.ts`）：`loopKind=native` 恒返回 `a2a`；非 native 返回 `graph` 只是类型占位，不参与实际 CLI 路由。

派发汇总见 `dispatchTaskToRole()`（`agent-pool.ts`）。

## loopOptionsJson 常用字段

| 字段 | 作用 |
|------|------|
| `executionPath` | 历史兼容；native 下不再改变派发路径 |
| `reactLoop` | `false` 强制 ReAct 单轮（仍走四阶段一次） |
| `command` / `extraArgs` / `timeoutMs` | CLI 子进程 |
| `injectMcpBridge` | CLI 运行目录注入 MCP manifest |

类型定义：`src/types/loop.ts`。

## ReAct 多轮

内建循环始终为 **perceive → reason → act → observe**。  
是否在 observe 后回到 reason 由 `resolveForceReactLoop()` 决定，默认 **`maxIterations > 1`**（见 `react-loop-policy.ts`）。

更完整的架构上下文见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
