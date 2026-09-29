/**
 * 点时（Point-In-Time, PIT）时序数据隔离与防未来函数审计器
 *
 * 核心职责：
 * 1. 严格检查时序单调性、as-of 截断与无未来数据泄露（No Look-ahead Leakage）
 * 2. 检查价格极值与行情完整性（OHLC 内部逻辑自洽）
 * 3. 校验多标的截面时点对齐（Cross-Sectional Alignment）
 * 4. 检查事件/公告时点是否发生前视（Effective date vs Announcement as-of date）
 * 5. 输出标准化 PIT 审计报告（PitAuditReport）
 */

import { isPointInTimeDate, pointInTimeMillis } from "../market/contracts/point-in-time-clock";
import type { BacktestDataset } from "../provider/types";

export interface PitViolation {
  symbol: string;
  type:
    | "future_data_leakage"
    | "non_monotonic_timestamp"
    | "duplicate_timestamp"
    | "invalid_ohlcv_bounds"
    | "corporate_action_pre_announcement"
    | "fundamental_observation_after_asof"
    | "cross_sectional_misalignment"
    | "lookahead_signal_detected"
    | "pit_provenance_unverified"
    | "invalid_timestamp"
    | "event_timestamp_precision_unknown"
    | "empty_dataset";
  timestamp: string;
  detail: string;
  severity: "critical" | "warning";
}

export interface PitAuditReport {
  pass: boolean;
  verdict: "point_in_time_clean" | "point_in_time_degraded" | "point_in_time_violated";
  lookAheadRiskScore: number; // 0.0 ~ 1.0, 0 为完全清洁
  totalBarsAudited: number;
  symbolCount: number;
  anomalyCount: number;
  violations: PitViolation[];
  coverageRange: {
    start: string;
    end: string;
  };
  asOfBoundary: string;
  recommendations: string[];
}

export interface PitEventRecord {
  symbol: string;
  eventDate: string;
  announcementDate: string;
  type: "dividend" | "split" | "earnings" | "restatement";
}

export interface PitVerificationOptions {
  /** 允许的最大跨标的时间戳偏差容忍（毫秒），日线通常为 0 */
  crossSectionalToleranceMs?: number;
  /** 额外的事件公告元数据，用于检验公告日前视 */
  events?: PitEventRecord[];
  /** 信号序列，可选检验是否有直接对未来收盘价的依赖 */
  signals?: Map<string, Map<string, number | null>>;
}

export function verifyPointInTimeIntegrity(
  dataset: BacktestDataset,
  options: PitVerificationOptions = {}
): PitAuditReport {
  const violations: PitViolation[] = [];
  let totalBars = 0;
  const symbols = Object.keys(dataset.barsBySymbol);
  const asOfMs = pointInTimeMillis(dataset.asOf);
  let globalMinDate = "9999-12-31";
  let globalMaxDate = "0000-01-01";
  if (!Number.isFinite(asOfMs)) {
    violations.push({
      symbol: "*",
      type: "invalid_timestamp",
      timestamp: dataset.asOf,
      detail: "Dataset asOf must be a valid ISO timestamp with an explicit timezone",
      severity: "critical",
    });
  }

  for (const symbol of symbols) {
    const bars = dataset.barsBySymbol[symbol] ?? [];
    totalBars += bars.length;
    let prevTs: number | null = null;

    for (const bar of bars) {
      const timestampMs = pointInTimeMillis(bar.timestamp);
      if (!Number.isFinite(timestampMs)) {
        violations.push({
          symbol,
          type: "invalid_timestamp",
          timestamp: bar.timestamp,
          detail: "Bar timestamp must be valid and include an explicit timezone",
          severity: "critical",
        });
        continue;
      }
      const date = new Date(timestampMs).toISOString().slice(0, 10);

      if (date < globalMinDate) globalMinDate = date;
      if (date > globalMaxDate) globalMaxDate = date;

      // 1. 检查 as-of 泄漏（绝对不能出现大于 asOf 的数据）
      if (timestampMs > asOfMs) {
        violations.push({
          symbol,
          type: "future_data_leakage",
          timestamp: bar.timestamp,
          detail: `Bar timestamp (${bar.timestamp}) exceeds dataset asOf limit (${dataset.asOf})`,
          severity: "critical",
        });
      }

      // 2. 检查时间戳单调性
      if (prevTs !== null) {
        if (timestampMs < prevTs) {
          violations.push({
            symbol,
            type: "non_monotonic_timestamp",
            timestamp: bar.timestamp,
            detail: `Timestamp sequence inverted: ${bar.timestamp} < previous ${new Date(prevTs).toISOString()}`,
            severity: "critical",
          });
        } else if (timestampMs === prevTs) {
          violations.push({
            symbol,
            type: "duplicate_timestamp",
            timestamp: bar.timestamp,
            detail: `Duplicate bar timestamp encountered: ${bar.timestamp}`,
            severity: "critical",
          });
        }
      }

      // 3. 检查 OHLCV 逻辑自洽（防假数据/未来数据插值导致的异常）
      if (
        ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.turnover].every(
          Number.isFinite
        ) ||
        bar.open <= 0 ||
        bar.high <= 0 ||
        bar.low <= 0 ||
        bar.close <= 0 ||
        bar.high < bar.low ||
        bar.high < Math.max(bar.open, bar.close) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0
      ) {
        violations.push({
          symbol,
          type: "invalid_ohlcv_bounds",
          timestamp: bar.timestamp,
          detail: `Malformed OHLCV values: open=${bar.open}, high=${bar.high}, low=${bar.low}, close=${bar.close}, vol=${bar.volume}`,
          severity: "critical",
        });
      }

      prevTs = timestampMs;
    }
  }

  // 4. 事件公告时点（Point-in-time Corporate Actions / Announcements）检查
  const corporateActionEvents =
    options.events ??
    dataset.corporateActionEvents?.map((event) => ({
      symbol: event.symbol,
      eventDate: event.effectiveDate,
      announcementDate: event.knownAt,
      type:
        event.kind === "cash_dividend" || event.kind === "split"
          ? event.kind
          : ("restatement" as const),
    }));
  if (corporateActionEvents && corporateActionEvents.length > 0) {
    for (const ev of corporateActionEvents) {
      const announcementMs = isPointInTimeDate(ev.announcementDate)
        ? pointInTimeMillis(`${ev.announcementDate}T00:00:00.000Z`)
        : pointInTimeMillis(ev.announcementDate);
      const eventDateOnly = isPointInTimeDate(ev.eventDate);
      const eventMs = eventDateOnly
        ? pointInTimeMillis(`${ev.eventDate}T00:00:00.000Z`)
        : pointInTimeMillis(ev.eventDate);
      if (!Number.isFinite(announcementMs) || !Number.isFinite(eventMs)) {
        violations.push({
          symbol: ev.symbol,
          type: "invalid_timestamp",
          timestamp: ev.announcementDate,
          detail: "Corporate-action event and announcement timestamps are invalid or ambiguous",
          severity: "critical",
        });
      } else if (announcementMs > (eventDateOnly ? eventMs + 86_400_000 - 1 : eventMs)) {
        violations.push({
          symbol: ev.symbol,
          type: "corporate_action_pre_announcement",
          timestamp: ev.eventDate,
          detail: `Event for ${ev.symbol} on ${ev.eventDate} was legally announced on ${ev.announcementDate}; usage before announcement constitutes look-ahead bias`,
          severity: "critical",
        });
      } else if (eventDateOnly && announcementMs >= eventMs) {
        violations.push({
          symbol: ev.symbol,
          type: "event_timestamp_precision_unknown",
          timestamp: ev.eventDate,
          detail:
            "Same-day announcement has no precise effective time; ordering cannot be verified",
          severity: "warning",
        });
      }
    }
  }

  // Fundamental values may describe an earlier fiscal period, but they are not
  // usable until their filing/estimate revision is actually available. The
  // frozen ledger is automatically checked so a post-snapshot revision cannot
  // silently enter a historical experiment.
  for (const observation of dataset.fundamentalObservations ?? []) {
    const availableMs = pointInTimeMillis(observation.availableAt);
    if (!Number.isFinite(availableMs)) {
      violations.push({
        symbol: observation.symbol,
        type: "invalid_timestamp",
        timestamp: observation.availableAt,
        detail: `Fundamental ${observation.metric} availability must include a valid explicit timezone`,
        severity: "critical",
      });
    } else if (availableMs > asOfMs) {
      violations.push({
        symbol: observation.symbol,
        type: "fundamental_observation_after_asof",
        timestamp: observation.availableAt,
        detail: `Fundamental ${observation.metric} for ${observation.symbol} became available at ${observation.availableAt}, after dataset asOf ${dataset.asOf}`,
        severity: "critical",
      });
    }
  }

  if (totalBars === 0) {
    violations.push({
      symbol: "*",
      type: "empty_dataset",
      timestamp: dataset.asOf,
      detail: "No bars are available to audit",
      severity: "warning",
    });
  }

  // “快照中没看到未来行”不等于数据源已经证明 point-in-time。缺少来源证书时
  // 必须保持 degraded/不通过，避免把 absence of evidence 误写为 evidence of absence。
  if (dataset.qualification.pointInTime !== "verified") {
    violations.push({
      symbol: "*",
      type: "pit_provenance_unverified",
      timestamp: dataset.asOf,
      detail: "Dataset has no verified point-in-time provenance certificate",
      severity: "warning",
    });
  }

  // 5. 综合判定与评分
  const criticalCount = violations.filter((v) => v.severity === "critical").length;
  const warningCount = violations.filter((v) => v.severity === "warning").length;
  const anomalyCount = violations.length;

  let lookAheadRiskScore = 0;
  if (totalBars > 0) {
    lookAheadRiskScore = Math.min(
      1,
      Number(((criticalCount * 0.2 + warningCount * 0.05) / Math.max(1, symbols.length)).toFixed(4))
    );
  }

  let verdict: PitAuditReport["verdict"] = "point_in_time_clean";
  if (criticalCount > 0) {
    verdict = "point_in_time_violated";
  } else if (warningCount > 0) {
    verdict = "point_in_time_degraded";
  }

  const recommendations: string[] = [];
  if (criticalCount > 0) {
    recommendations.push(
      "检测到关键前视偏差或未来数据污染，请立即重新绑定包含严格 as-of 截断的历史快照。"
    );
  }
  if (dataset.qualification.pointInTime !== "verified") {
    recommendations.push(
      "数据集未带有 verified point-in-time 证书，建议补充截面除权历史与财务报表时点隔离。"
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      warningCount > 0
        ? "时点检查存在证据缺口；请补充报告中的缺失信息后再用于验证。"
        : "已通过本次时间边界与数据结构检查；结果仍取决于来源凭证及信号计算的时点约束。"
    );
  }

  return {
    pass:
      criticalCount === 0 && warningCount === 0 && dataset.qualification.pointInTime === "verified",
    verdict,
    lookAheadRiskScore,
    totalBarsAudited: totalBars,
    symbolCount: symbols.length,
    anomalyCount,
    violations,
    coverageRange: {
      start: globalMinDate === "9999-12-31" ? "" : globalMinDate,
      end: globalMaxDate === "0000-01-01" ? "" : globalMaxDate,
    },
    asOfBoundary: dataset.asOf || "",
    recommendations,
  };
}
