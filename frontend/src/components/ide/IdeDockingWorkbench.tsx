import type { FC, ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Layout,
  Model,
  type IJsonModel,
  type TabNode,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import {
  Activity,
  Code2,
  Columns,
  Grid2X2,
  LayoutGrid,
  RotateCcw,
} from "lucide-react";
import { KlinePanel } from "../chart/KlinePanel";
import { MarketWatchlistPanel } from "../market/MarketWatchlistPanel";
import { WorkspaceBottomPanel } from "../workspace/WorkspaceBottomPanel";
import { IdeBacktestDock } from "./IdeBacktestDock";
import { IdeEditorPane } from "./IdeEditorPane";
import { IdeOutlinePanel } from "./IdeOutlinePanel";
import { IdeQuickTradePanel } from "./IdeQuickTradePanel";

export type DockPresetId = "default_quant" | "code_focus" | "backtest_lab" | "quad_split";

const STORAGE_KEY = "qubit.ide.docking_layout.v1";

const PRESET_CONFIGS: Record<DockPresetId, { name: string; icon: any; layout: IJsonModel }> = {
  default_quant: {
    name: "经典投研分屏",
    icon: Columns,
    layout: {
      global: {
        tabEnableClose: true,
        tabEnableRename: false,
        tabSetEnableDrop: true,
        tabSetEnableDrag: true,
        tabSetEnableMaximize: true,
        tabSetMinWidth: 200,
        tabSetMinHeight: 160,
      },
      borders: [],
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 42,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "策略代码编辑",
                component: "editor",
                id: "tab_editor",
                enableClose: false,
              },
              {
                type: "tab",
                name: "符号大纲",
                component: "outline",
                id: "tab_outline",
              },
              {
                type: "tab",
                name: "自选行情",
                component: "watchlist",
                id: "tab_watchlist",
              },
            ],
          },
          {
            type: "row",
            weight: 58,
            children: [
              {
                type: "tabset",
                weight: 52,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "K线行情分析",
                    component: "chart",
                    id: "tab_chart",
                  },
                  {
                    type: "tab",
                    name: "闪电交易",
                    component: "quicktrade",
                    id: "tab_quicktrade",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 48,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "量化回测工坊",
                    component: "backtest",
                    id: "tab_backtest",
                  },
                  {
                    type: "tab",
                    name: "运行日志",
                    component: "terminal",
                    id: "tab_terminal",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  code_focus: {
    name: "代码专注大纲",
    icon: Code2,
    layout: {
      global: {
        tabEnableClose: true,
        tabSetEnableMaximize: true,
        tabSetMinWidth: 180,
      },
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 22,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "代码大纲",
                component: "outline",
                id: "tab_outline",
              },
              {
                type: "tab",
                name: "自选列表",
                component: "watchlist",
                id: "tab_watchlist",
              },
            ],
          },
          {
            type: "tabset",
            weight: 52,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "策略代码编辑",
                component: "editor",
                id: "tab_editor",
                enableClose: false,
              },
            ],
          },
          {
            type: "tabset",
            weight: 26,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "K线图表",
                component: "chart",
                id: "tab_chart",
              },
              {
                type: "tab",
                name: "回测面板",
                component: "backtest",
                id: "tab_backtest",
              },
            ],
          },
        ],
      },
    },
  },
  backtest_lab: {
    name: "回测工坊全屏",
    icon: Activity,
    layout: {
      global: {
        tabEnableClose: true,
        tabSetEnableMaximize: true,
      },
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 35,
            selected: 0,
            children: [
              {
                type: "tab",
                name: "策略代码",
                component: "editor",
                id: "tab_editor",
              },
              {
                type: "tab",
                name: "符号大纲",
                component: "outline",
                id: "tab_outline",
              },
            ],
          },
          {
            type: "row",
            weight: 65,
            children: [
              {
                type: "tabset",
                weight: 60,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "量化回测工坊",
                    component: "backtest",
                    id: "tab_backtest",
                    enableClose: false,
                  },
                ],
              },
              {
                type: "tabset",
                weight: 40,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "标的走势与基准",
                    component: "chart",
                    id: "tab_chart",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  quad_split: {
    name: "四象限全景矩阵",
    icon: Grid2X2,
    layout: {
      global: {
        tabEnableClose: true,
        tabSetEnableMaximize: true,
      },
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "row",
            weight: 50,
            children: [
              {
                type: "tabset",
                weight: 50,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "策略代码",
                    component: "editor",
                    id: "tab_editor",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 50,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "自选与大纲",
                    component: "watchlist",
                    id: "tab_watchlist",
                  },
                  {
                    type: "tab",
                    name: "符号大纲",
                    component: "outline",
                    id: "tab_outline",
                  },
                ],
              },
            ],
          },
          {
            type: "row",
            weight: 50,
            children: [
              {
                type: "tabset",
                weight: 50,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "K线分析",
                    component: "chart",
                    id: "tab_chart",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 50,
                selected: 0,
                children: [
                  {
                    type: "tab",
                    name: "回测报表",
                    component: "backtest",
                    id: "tab_backtest",
                  },
                  {
                    type: "tab",
                    name: "闪电交易",
                    component: "quicktrade",
                    id: "tab_quicktrade",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  },
};

export const IdeDockingWorkbench: FC = () => {
  const [activePreset, setActivePreset] = useState<DockPresetId>("default_quant");

  const initialModel = useMemo(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const json = JSON.parse(saved);
        return Model.fromJson(json);
      }
    } catch {
      // fallback
    }
    return Model.fromJson(PRESET_CONFIGS.default_quant.layout);
  }, []);

  const [model, setModel] = useState<Model>(initialModel);
  const layoutRef = useRef<any>(null);

  const saveLayout = useCallback((m: Model) => {
    try {
      const json = m.toJson();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
    } catch {
      // ignore
    }
  }, []);

  const handleModelChange = useCallback(
    (newModel: Model) => {
      saveLayout(newModel);
    },
    [saveLayout]
  );

  const applyPreset = (presetId: DockPresetId) => {
    setActivePreset(presetId);
    const newModel = Model.fromJson(PRESET_CONFIGS[presetId].layout);
    setModel(newModel);
    saveLayout(newModel);
  };

  const addPanel = (component: string, name: string) => {
    if (!layoutRef.current) return;
    layoutRef.current.addTabToActiveTabSet({
      type: "tab",
      component,
      name,
    });
  };

  const factory = (node: TabNode): ReactNode => {
    const comp = node.getComponent();
    switch (comp) {
      case "editor":
        return (
          <div style={dockNodeStyles.fill}>
            <IdeEditorPane />
          </div>
        );
      case "chart":
        return (
          <div style={dockNodeStyles.fill}>
            <KlinePanel embedded linkTraderMarkers />
          </div>
        );
      case "backtest":
        return (
          <div style={dockNodeStyles.fill}>
            <IdeBacktestDock />
          </div>
        );
      case "watchlist":
        return (
          <div style={dockNodeStyles.fill}>
            <MarketWatchlistPanel compact />
          </div>
        );
      case "outline":
        return (
          <div style={dockNodeStyles.fill}>
            <IdeOutlinePanel />
          </div>
        );
      case "quicktrade":
        return (
          <div style={dockNodeStyles.fill}>
            <IdeQuickTradePanel />
          </div>
        );
      case "terminal":
        return (
          <div style={dockNodeStyles.fill}>
            <WorkspaceBottomPanel />
          </div>
        );
      default:
        return <div style={dockNodeStyles.unknown}>未识别的面板组件: {comp}</div>;
    }
  };

  return (
    <div style={dockStyles.container} data-qb-docking-workbench>
      <div style={dockStyles.topBar}>
        <div style={dockStyles.titleGroup}>
          <LayoutGrid size={13} color="var(--qb-blue, #60a5fa)" />
          <span style={dockStyles.titleText}>Docking 自由停靠工作台</span>
          <span style={dockStyles.badge}>支持任意拖拽/并排分拆/最大化</span>
        </div>

        <div style={dockStyles.actionsGroup}>
          <div style={dockStyles.presetGroup}>
            <span style={dockStyles.presetLabel}>布局预设:</span>
            {(Object.keys(PRESET_CONFIGS) as DockPresetId[]).map((pid) => {
              const cfg = PRESET_CONFIGS[pid];
              const Icon = cfg.icon;
              const isActive = activePreset === pid;
              return (
                <button
                  key={pid}
                  type="button"
                  onClick={() => applyPreset(pid)}
                  style={{
                    ...dockStyles.presetBtn,
                    ...(isActive ? dockStyles.presetBtnActive : null),
                  }}
                  title={cfg.name}
                >
                  <Icon size={11} />
                  <span>{cfg.name}</span>
                </button>
              );
            })}
          </div>

          <div style={dockStyles.panelAddGroup}>
            <button
              type="button"
              style={dockStyles.panelAddBtn}
              onClick={() => addPanel("editor", "代码编辑")}
              title="添加代码编辑面板"
            >
              + 代码
            </button>
            <button
              type="button"
              style={dockStyles.panelAddBtn}
              onClick={() => addPanel("chart", "K线行情")}
              title="添加行情图表面板"
            >
              + 行情
            </button>
            <button
              type="button"
              style={dockStyles.panelAddBtn}
              onClick={() => addPanel("backtest", "量化回测")}
              title="添加回测工坊面板"
            >
              + 回测
            </button>
            <button
              type="button"
              style={dockStyles.panelAddBtn}
              onClick={() => addPanel("outline", "符号大纲")}
              title="添加代码大纲面板"
            >
              + 大纲
            </button>
            <button
              type="button"
              style={dockStyles.resetBtn}
              onClick={() => applyPreset("default_quant")}
              title="重置停靠布局到默认"
            >
              <RotateCcw size={11} />
              <span>重置</span>
            </button>
          </div>
        </div>
      </div>

      <div style={dockStyles.layoutHost} className="qb-flexlayout-host">
        <Layout
          ref={layoutRef}
          model={model}
          factory={factory}
          onModelChange={handleModelChange}
        />
      </div>
    </div>
  );
};

const dockNodeStyles = {
  fill: {
    width: "100%",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column" as const,
  },
  unknown: {
    padding: 16,
    color: "#ef4444",
    fontSize: 12,
  },
};

const dockStyles = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    minHeight: 0,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    background: "var(--qb-bg-root, #1e1e1e)",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px",
    background: "var(--qb-bg-root-top, #252526)",
    borderBottom: "1px solid var(--qb-separator, #2d2d2d)",
    fontSize: 11,
    flexShrink: 0,
    gap: 8,
    flexWrap: "wrap" as const,
  },
  titleGroup: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  titleText: {
    fontWeight: 600,
    color: "var(--qb-body-fg, #ffffff)",
    fontSize: 11.5,
  },
  badge: {
    fontSize: 10,
    color: "var(--qb-body-muted, #858585)",
    marginLeft: 4,
  },
  actionsGroup: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  presetGroup: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  presetLabel: {
    fontSize: 10,
    color: "var(--qb-body-muted, #858585)",
  },
  presetBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "var(--qb-main-input-bg, #3c3c3c)",
    border: "1px solid var(--qb-separator, #2d2d2d)",
    color: "var(--qb-body-fg, #cccccc)",
    borderRadius: 3,
    fontSize: 10.5,
    padding: "2px 6px",
    cursor: "pointer",
    transition: "all 0.12s ease",
  },
  presetBtnActive: {
    background: "var(--qb-blue, #007acc)",
    borderColor: "var(--qb-blue, #007acc)",
    color: "#ffffff",
    fontWeight: 600,
  },
  panelAddGroup: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  panelAddBtn: {
    display: "inline-flex",
    alignItems: "center",
    background: "transparent",
    border: "1px dashed var(--qb-separator, #3c3c3c)",
    color: "var(--qb-body-muted, #858585)",
    borderRadius: 3,
    fontSize: 10,
    padding: "2px 5px",
    cursor: "pointer",
  },
  resetBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    background: "transparent",
    border: "1px solid var(--qb-separator, #2d2d2d)",
    color: "var(--qb-body-muted, #858585)",
    borderRadius: 3,
    fontSize: 10.5,
    padding: "2px 6px",
    cursor: "pointer",
  },
  layoutHost: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    position: "relative" as const,
    overflow: "hidden",
  },
};
