/**
 * @deprecated P2-D 物理迁移：本文件已迁至 `src/runtime/execution/broker/broker-service.ts`。
 * 这里保留 re-export 让外部 import 平滑过渡，下一轮（P3）会删除本文件。
 *
 * 新代码请直接 `import { ... } from "../execution/broker/broker-service"`。
 */
export {
  brokerCancelOrder,
  brokerGetFills,
  brokerGetPositions,
  brokerHealthCheck,
  connectorForAccount,
  resolveBrokerAccount,
  type ResolvedBrokerAccount,
} from "../execution/broker/broker-service";
