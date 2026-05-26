/**
 * 监控 V2 P2 — 在 ACP caller 注入 connector_call_log 写入 hook。
 *
 * 为什么单独一个文件而不直接在 messaging/acp.ts import logger？
 *   - messaging/acp.ts 是底层 ACP 协议层，必须保持「无 sqlite / 无 runtime」依赖；
 *     否则消息测试 / connectors 单测都会要 bootstrap 数据库。
 *   - 改用 hook 注入：runtime 启动期（src/index.ts）调一次 `installAcpMonitoringHook()`
 *     就行；测试 / connector 单测不调，acp.ts 行为不变。
 *
 * 落库范围（targetKind === "connector"）：
 *   只对 connector 调用打点；MCP / skill / tool 已有各自专用打点路径
 *   （mcp_call_log / agent_skill_run / tool_call_log），重复打点反而噪音。
 */
import { defaultAcpCaller, type AcpCallObservedEvent } from "../../messaging/acp";
import {
  writeConnectorCallLog,
  type ConnectorOperation,
} from "./connector-call-logger";

let installed = false;

/**
 * 启动期调用一次；幂等（重复调用只生效一次）。
 */
export function installAcpMonitoringHook(): void {
  if (installed) return;
  defaultAcpCaller.setOnCallObserved(async (event) => {
    if (event.request.targetKind !== "connector") return;
    await writeAcpEventAsConnectorLog(event);
  });
  installed = true;
}

/** 测试用：移除 hook + 重置 installed flag */
export function uninstallAcpMonitoringHookForTest(): void {
  defaultAcpCaller.setOnCallObserved(null);
  installed = false;
}

/**
 * 把 AcpCallObservedEvent 翻译成 connector_call_log 行的入参。
 * 暴露给单测以便直接验证字段映射（避免依赖 ACP 路由）。
 */
export async function writeAcpEventAsConnectorLog(event: AcpCallObservedEvent): Promise<void> {
  await writeConnectorCallLog(buildConnectorLogInputFromAcpEvent(event));
}

/**
 * 纯函数：AcpCallObservedEvent → ConnectorCallLogInput。
 * 抽出来单独 export 是为了让单测可以不接 sqlite 直接验证字段映射。
 */
export function buildConnectorLogInputFromAcpEvent(
  event: AcpCallObservedEvent
): Parameters<typeof writeConnectorCallLog>[0] {
  const { request, resultPayload, latencyMs, status, errorMessage } = event;
  const operation = inferOperation(request.intent);
  const mappedStatus = mapAcpStatusToConnectorStatus(status);
  return {
    traceId: request.traceId,
    workflowRunId: request.workflowId,
    connectorName: request.targetName,
    operation,
    request: {
      intent: request.intent,
      payload: request.payload,
      sessionId: request.sessionId,
      senderAgent: request.senderAgent,
      riskLevel: request.riskLevel,
    },
    response: resultPayload,
    latencyMs,
    status: mappedStatus,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/**
 * ACP intent ↔ connector operation 映射：
 *   - "execute" / "call" 等业务 intent → execute（默认）
 *   - "init"            → init
 *   - "healthcheck"     → healthcheck
 *   - "shutdown"        → shutdown
 * intent 是 free text，这里只识别 init/healthcheck/shutdown，其它都按 execute。
 */
export function inferOperation(intent: string | undefined | null): ConnectorOperation {
  const norm = (intent ?? "").toLowerCase().trim();
  if (norm === "init") return "init";
  if (norm === "healthcheck" || norm === "health_check" || norm === "ping") return "healthcheck";
  if (norm === "shutdown" || norm === "close") return "shutdown";
  return "execute";
}

/**
 * AcpResponse.status ↔ connector_call_log.status 映射：
 *   - 'success'  → 'success'
 *   - 'timeout'  → 'timeout'
 *   - 'error'    → 'error'
 *   - 'blocked'  → 'error'（沙箱 / risk 阻断也归错，复用 connector_call_log status 枚举）
 */
export function mapAcpStatusToConnectorStatus(
  status: AcpCallObservedEvent["status"]
): "success" | "error" | "timeout" {
  if (status === "success") return "success";
  if (status === "timeout") return "timeout";
  return "error";
}
