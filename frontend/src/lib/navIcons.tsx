import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  ChartCandlestick,
  FlaskConical,
  Landmark,
  MessageSquare,
  PanelsTopLeft,
  Settings2,
  Users,
} from "lucide-react";
import type { FC } from "react";

/**
 * Web 端导航图标：与 `appleUiSymbols.ts` 中的 SF Symbols 语义一一对应，
 * 若日后做 Apple 原生壳可映射到 `Image(systemName:)`。
 */
export type NavKey =
  | "ide"
  | "chart"
  | "chat"
  | "team"
  | "trader"
  | "quant"
  | "monitor"
  | "broker"
  | "config";

export const NAV_ICON_MAP: Record<NavKey, LucideIcon> = {
  ide: PanelsTopLeft,
  chart: ChartCandlestick,
  chat: MessageSquare,
  team: Users,
  trader: Bot,
  quant: FlaskConical,
  monitor: Activity,
  broker: Landmark,
  config: Settings2,
};

const stroke = 1.75;

export const NavGlyph: FC<{
  navKey: NavKey;
  size?: number;
  className?: string;
  color?: string;
}> = ({ navKey, size = 18, className, color }) => {
  const Icon = NAV_ICON_MAP[navKey];
  return <Icon size={size} strokeWidth={stroke} absoluteStrokeWidth className={className} color={color} aria-hidden />;
};
