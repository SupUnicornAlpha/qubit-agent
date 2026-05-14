import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, FC } from "react";

export type IconToolbarButtonProps = {
  Icon: LucideIcon;
  /** 悬停原生提示 + 读屏标签 */
  label: string;
  active?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/**
 * IDE 工具栏图标按钮：接近 SF Symbols 在工具栏中的尺寸与反馈（Web 上用 Lucide 近似）。
 */
export const IconToolbarButton: FC<IconToolbarButtonProps> = ({
  Icon,
  label,
  active,
  className,
  type = "button",
  ...rest
}) => (
  <button
    type={type}
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={`qb-icon-btn${active ? " qb-icon-btn--active" : ""}${className ? ` ${className}` : ""}`}
    {...rest}
  >
    <Icon size={17} strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
  </button>
);
