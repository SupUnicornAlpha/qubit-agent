/**
 * @deprecated P2-D 物理迁移：本文件已迁至 `src/runtime/execution/broker/broker-admin.ts`。
 * 这里保留 re-export 让外部 import 平滑过渡，下一轮（P3）会删除本文件。
 *
 * 新代码请直接 `import { ... } from "../execution/broker/broker-admin"`。
 */
export {
  brokerHealthCheck,
  checkBrokerAccountHealth,
  listBrokerAccounts,
  listBrokerEvents,
  resolveBrokerAccount,
  upsertBrokerAccount,
} from "../execution/broker/broker-admin";
