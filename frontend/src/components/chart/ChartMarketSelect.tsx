import type { CSSProperties, FC, SelectHTMLAttributes } from "react";
import { CHART_MARKET_GROUPS, coerceChartMarketExchange } from "../../lib/chartSpec";

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  value: string;
  onChange: (exchange: string) => void;
  style?: CSSProperties;
};

export const ChartMarketSelect: FC<Props> = ({ value, onChange, style, ...rest }) => (
  <select
    {...rest}
    style={style}
    value={coerceChartMarketExchange(value)}
    onChange={(e) => onChange(e.target.value)}
    aria-label={rest["aria-label"] ?? "市场"}
  >
    {CHART_MARKET_GROUPS.map((group) => (
      <optgroup key={group.label} label={group.label}>
        {group.options.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </optgroup>
    ))}
  </select>
);
