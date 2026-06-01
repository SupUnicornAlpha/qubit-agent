/**
 * EnvironmentPanel —— 配置中心 → 环境管理 主面板。
 *
 * 三 tab：
 *   1. 依赖状态：Python pip + MCP npm 的 diff + connector probes + 一键 install/uninstall
 *   2. 期望清单：env_registry CRUD（系统项可改 status / userVersionSpec；用户项全编辑）
 *   3. 安装历史：env_install_log 表格 + 短轮询 running 行
 *
 * 详见 docs/ENVIRONMENT_MANAGER_DESIGN.md §6.6。
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import { EnvDepsTab } from "./EnvDepsTab";
import { EnvInstallLogTab } from "./EnvInstallLogTab";
import { EnvRegistryEditor } from "./EnvRegistryEditor";

type TabId = "deps" | "registry" | "log";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "deps", label: "依赖状态" },
  { id: "registry", label: "期望清单" },
  { id: "log", label: "安装历史" },
];

const tabsRow: CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 14,
  borderBottom: "1px solid #27272a",
};

export function EnvironmentPanel() {
  const [tab, setTab] = useState<TabId>("deps");

  return (
    <>
      <h3 style={{ marginTop: 0 }}>环境管理</h3>
      <p className="qb-config-hint">
        统一管理 Python pip 依赖、MCP stdio npm 包与各 connector 健康度。期望清单
        来自代码 seed（requirements.txt + 推荐 MCP）+ 用户编辑覆写，参考{" "}
        <code>docs/ENVIRONMENT_MANAGER_DESIGN.md</code>。
      </p>

      <div role="tablist" style={tabsRow}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`qb-segmented__tab${tab === id ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "deps" ? <EnvDepsTab /> : null}
      {tab === "registry" ? <EnvRegistryEditor /> : null}
      {tab === "log" ? <EnvInstallLogTab /> : null}
    </>
  );
}
