/**
 * 与 QUBIT（量化研究 / Agent / IDE）场景对应的 SF Symbols 名称参考。
 *
 * 来源与许可：
 * - [SF Symbols](https://developer.apple.com/cn/sf-symbols/)：Apple 提供的界面符号库，需在 **SF Symbols.app** 中核对准确名称与可用变体。
 * - Apple 要求：SF Symbols **仅用于在 Apple 操作系统上运行的软件**（见 SF Symbols 许可协议）。
 *
 * Web 端无法直接渲染 SF Symbols；当前前端在 `navIcons.tsx` 中用 **Lucide** 做了语义对齐的替代实现。
 * 若未来做 **macOS / iOS 原生壳**，可按下列名称映射到 `Image(systemName:)`。
 */

/** 侧边栏 / 主导航（与 `Sidebar.tsx` 中 key 对齐） */
export const navSfSymbolCandidates: Record<
  "ide" | "chart" | "chat" | "team" | "trader" | "monitor" | "broker" | "config",
  readonly string[]
> = {
  ide: ["macwindow", "square.grid.2x2", "sidebar.left"],
  chart: ["chart.line.uptrend.xyaxis", "chart.xyaxis.line", "chart.bar.xaxis"],
  chat: ["bubble.left.and.bubble.right", "text.bubble", "ellipsis.bubble"],
  team: ["person.3", "person.2", "person.crop.circle.badge.plus"],
  trader: ["bolt.horizontal", "cpu", "antenna.radiowaves.left.and.right", "wand.and.stars"],
  monitor: ["waveform.path.ecg", "clock.arrow.circlepath", "chart.xyaxis.line"],
  broker: ["building.columns.fill", "banknote", "creditcard"],
  config: ["gearshape", "slider.horizontal.3", "wrench.and.screwdriver"],
};

/** 研究 / 回测 / 数据等扩展场景 */
export const featureSfSymbolCandidates = {
  strategyCode: ["curlybraces", "chevron.left.forwardslash.chevron.right", "doc.richtext"],
  dataTable: ["tablecells", "rectangle.split.3x1"],
  mathModel: ["function", "x.squareroot", "sigma"],
  networkApi: ["network", "link", "cable.connector"],
  timeRange: ["calendar", "clock", "timer"],
  alertRisk: ["exclamationmark.triangle", "bell.badge"],
  sparkAi: ["sparkles", "star.fill"],
} as const;
