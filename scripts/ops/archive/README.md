# 历史一次性运维/排查脚本归档 (Scripts Archive)

本目录归档历史开发与排障过程中使用的一次性诊断、压测分析或脏数据清理脚本。

> ⚠️ **注意**：本目录下的脚本多为针对特定历史场景编写，直接在生产或现有数据库执行可能造成数据重置或影响业务，请谨慎按需查阅或在隔离测试环境中复用。

## 归档脚本清单

- `_cleanup_all_sessions.ts`: 历史全量会话强制清空脚本
- `_cleanup_workflows.ts`: 历史批量重置 workflow 脚本
- `_cleanup_test_workspaces.ts`: 清理测试临时 workspace 脚本
- `_test-mcp-spawn.ts`: 早期 MCP 进程 spawn 调试脚本
- `_assess_5_capabilities.ts`: 历史 5 维能力打分分析脚本
- `_diag_factor_autoeval.ts`: 因子 autoEvaluate 异常诊断脚本
- `_diag_fk_fail.ts`: 外键级联约束诊断脚本
- `_db_size_breakdown.ts`: 数据库表体积统计脚本
- `_purge_old_bak.ts`: 历史备份文件清理脚本
- `_analyze_langgraph_checkpoint.ts`: 早期 LangGraph checkpoint 数据分析脚本
- `_purge_orphan_checkpoints.ts`: 早期 LangGraph 孤儿 checkpoint 清理脚本
