import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { AlertTriangle, BellRing, Brain, CheckCircle2, Clock3, FileCode2, FlaskConical, Play, RefreshCw } from "lucide-react";
import {
  ackAlert,
  listAlerts,
  listBacktestJobs,
  listFactors,
  listMemoryExperiences,
  listScheduledJobs,
  listStrategyVersions,
  patchScheduledJob,
  resolveAlert,
  runScheduledJobNow,
  type BacktestJobRecord,
  type FactorRecord,
  type MemoryExperienceListItem,
  type StrategyVersionFlatRecord,
} from "../../api/backend";
import type { AlertEventRecord, ScheduledJobRecord } from "../../api/types";
import { useTranslation } from "../../i18n";

type ProjectScope = { projectId: string };

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const SimplePageFrame: FC<{
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}> = ({ eyebrow, title, description, action, children }) => (
  <section className="qb-simple-page">
    <header className="qb-simple-page__hero">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="qb-simple-page__action">{action}</div> : null}
    </header>
    {children}
  </section>
);

const EmptyState: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="qb-simple-empty">{children}</div>
);

const PageError: FC<{ text: string }> = ({ text }) => (
  <div className="qb-simple-page-error"><AlertTriangle size={15} /> {text}</div>
);

export const SimpleTasksPage: FC<ProjectScope & { workspaceId: string }> = ({ workspaceId, projectId }) => {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ScheduledJobRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!workspaceId || !projectId) return;
    setLoading(true);
    setError("");
    try {
      setJobs(await listScheduledJobs({ workspaceId, projectId }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t, workspaceId]);

  useEffect(() => { void reload(); }, [reload]);

  const toggleJob = async (job: ScheduledJobRecord) => {
    setBusyId(job.id);
    try {
      await patchScheduledJob(job.id, { enabled: !job.enabled });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.actionFailed"));
    } finally {
      setBusyId("");
    }
  };

  const runNow = async (job: ScheduledJobRecord) => {
    setBusyId(job.id);
    try {
      await runScheduledJobNow(job.id);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.actionFailed"));
    } finally {
      setBusyId("");
    }
  };

  return (
    <SimplePageFrame
      eyebrow={t("simpleMode.pages.tasks.eyebrow")}
      title={t("simpleMode.pages.tasks.title")}
      description={t("simpleMode.pages.tasks.description")}
      action={<button className="qb-simple-icon-btn" type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={15} /> {t("common.action.refresh")}</button>}
    >
      {error ? <PageError text={error} /> : null}
      <div className="qb-simple-summary-line">
        <strong>{jobs.filter((job) => job.enabled).length}</strong> {t("simpleMode.pages.tasks.activeCount")} · {jobs.length} {t("simpleMode.pages.tasks.totalCount")}
      </div>
      <div className="qb-simple-list">
        {jobs.map((job) => (
          <article className="qb-simple-row" key={job.id}>
            <div className="qb-simple-row__icon"><Clock3 size={17} /></div>
            <div className="qb-simple-row__body">
              <div className="qb-simple-row__title">{job.name}</div>
              <div className="qb-simple-row__meta">{job.cronExpr} · {job.timezone} · {job.executionMode}</div>
              <div className="qb-simple-row__meta">{t("simpleMode.pages.tasks.nextRun")}: {formatTime(job.nextRunAt)}</div>
            </div>
            <div className="qb-simple-row__actions">
              <button type="button" onClick={() => void runNow(job)} disabled={busyId === job.id}><Play size={14} /> {t("simpleMode.pages.tasks.runNow")}</button>
              <button type="button" className={job.enabled ? "is-active" : ""} onClick={() => void toggleJob(job)} disabled={busyId === job.id}>{job.enabled ? t("simpleMode.pages.tasks.enabled") : t("simpleMode.pages.tasks.paused")}</button>
            </div>
          </article>
        ))}
        {!loading && jobs.length === 0 ? <EmptyState>{t("simpleMode.pages.tasks.empty")}</EmptyState> : null}
      </div>
    </SimplePageFrame>
  );
};

export const SimpleAlertsPage: FC = () => {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<AlertEventRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAlerts(await listAlerts({ limit: 60 }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const updateAlert = async (alert: AlertEventRecord, action: "ack" | "resolve") => {
    setBusyId(alert.id);
    try {
      await (action === "ack" ? ackAlert(alert.id) : resolveAlert(alert.id));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.actionFailed"));
    } finally {
      setBusyId("");
    }
  };

  const openCount = alerts.filter((alert) => alert.status === "open").length;
  return (
    <SimplePageFrame
      eyebrow={t("simpleMode.pages.alerts.eyebrow")}
      title={t("simpleMode.pages.alerts.title")}
      description={t("simpleMode.pages.alerts.description")}
      action={<button className="qb-simple-icon-btn" type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={15} /> {t("common.action.refresh")}</button>}
    >
      {error ? <PageError text={error} /> : null}
      <div className="qb-simple-summary-line"><strong>{openCount}</strong> {t("simpleMode.pages.alerts.openCount")} · {alerts.length} {t("simpleMode.pages.alerts.totalCount")}</div>
      <div className="qb-simple-list">
        {alerts.map((alert) => (
          <article className={`qb-simple-row qb-simple-row--${alert.severity}`} key={alert.id}>
            <div className="qb-simple-row__icon"><BellRing size={17} /></div>
            <div className="qb-simple-row__body">
              <div className="qb-simple-row__title">{alert.title}</div>
              <div className="qb-simple-row__meta">{alert.severity} · {alert.scopeType} · {formatTime(alert.createdAt)}</div>
            </div>
            <div className="qb-simple-row__actions">
              {alert.status === "open" ? <button type="button" onClick={() => void updateAlert(alert, "ack")} disabled={busyId === alert.id}>{t("simpleMode.pages.alerts.ack")}</button> : null}
              {alert.status !== "resolved" ? <button type="button" onClick={() => void updateAlert(alert, "resolve")} disabled={busyId === alert.id}>{t("simpleMode.pages.alerts.resolve")}</button> : <span className="qb-simple-resolved"><CheckCircle2 size={14} /> {t("simpleMode.pages.alerts.resolved")}</span>}
            </div>
          </article>
        ))}
        {!loading && alerts.length === 0 ? <EmptyState>{t("simpleMode.pages.alerts.empty")}</EmptyState> : null}
      </div>
    </SimplePageFrame>
  );
};

export const SimpleMemoryPage: FC<ProjectScope> = ({ projectId }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryExperienceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const result = await listMemoryExperiences({ projectId, limit: 50, orderBy: "valid_from_desc" });
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <SimplePageFrame
      eyebrow={t("simpleMode.pages.memory.eyebrow")}
      title={t("simpleMode.pages.memory.title")}
      description={t("simpleMode.pages.memory.description")}
      action={<button className="qb-simple-icon-btn" type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={15} /> {t("common.action.refresh")}</button>}
    >
      {error ? <PageError text={error} /> : null}
      <div className="qb-simple-summary-line"><strong>{total}</strong> {t("simpleMode.pages.memory.totalCount")}</div>
      <div className="qb-simple-list">
        {items.map((item) => (
          <article className="qb-simple-row" key={item.id}>
            <div className="qb-simple-row__icon"><Brain size={17} /></div>
            <div className="qb-simple-row__body">
              <div className="qb-simple-row__title">{item.summary}</div>
              <div className="qb-simple-row__meta">{item.kind} / {item.subKind || "general"} · quality {item.qualityScore.toFixed(2)} · used {item.useCount}</div>
              <div className="qb-simple-tags">{item.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div>
            </div>
            <div className="qb-simple-row__time">{formatTime(item.validFrom)}</div>
          </article>
        ))}
        {!loading && items.length === 0 ? <EmptyState>{t("simpleMode.pages.memory.empty")}</EmptyState> : null}
      </div>
    </SimplePageFrame>
  );
};

type ArtifactEntry = {
  id: string;
  kind: "factor" | "strategy" | "backtest";
  title: string;
  meta: string;
  createdAt: string;
};

export const SimpleArtifactsPage: FC<ProjectScope> = ({ projectId }) => {
  const { t } = useTranslation();
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [strategies, setStrategies] = useState<StrategyVersionFlatRecord[]>([]);
  const [backtests, setBacktests] = useState<BacktestJobRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const [nextFactors, nextStrategies, nextBacktests] = await Promise.all([
        listFactors({ projectId }),
        listStrategyVersions({ projectId }),
        listBacktestJobs({ projectId }),
      ]);
      setFactors(nextFactors);
      setStrategies(nextStrategies);
      setBacktests(nextBacktests);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("simpleMode.pages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void reload(); }, [reload]);

  const entries = useMemo<ArtifactEntry[]>(() => [
    ...factors.map((factor) => ({ id: factor.id, kind: "factor" as const, title: factor.name, meta: `${factor.category} · ${factor.status} · ${factor.universe}`, createdAt: factor.createdAt })),
    ...strategies.map((strategy) => ({ id: strategy.id, kind: "strategy" as const, title: strategy.strategyName, meta: `${strategy.versionTag} · ${strategy.strategyStyle}`, createdAt: strategy.createdAt })),
    ...backtests.map((backtest) => ({ id: backtest.id, kind: "backtest" as const, title: `${t("simpleMode.pages.artifacts.backtest")} ${backtest.id.slice(0, 8)}`, meta: `${backtest.status} · ${backtest.engineKey}${backtest.result ? ` · return ${(backtest.result.metrics.totalReturn * 100).toFixed(2)}%` : ""}`, createdAt: backtest.startedAt })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [backtests, factors, strategies, t]);

  const iconFor = (kind: ArtifactEntry["kind"]) => kind === "factor" ? <FlaskConical size={17} /> : kind === "strategy" ? <FileCode2 size={17} /> : <Play size={17} />;

  return (
    <SimplePageFrame
      eyebrow={t("simpleMode.pages.artifacts.eyebrow")}
      title={t("simpleMode.pages.artifacts.title")}
      description={t("simpleMode.pages.artifacts.description")}
      action={<button className="qb-simple-icon-btn" type="button" onClick={() => void reload()} disabled={loading}><RefreshCw size={15} /> {t("common.action.refresh")}</button>}
    >
      {error ? <PageError text={error} /> : null}
      <div className="qb-simple-artifact-counts">
        <span><strong>{factors.length}</strong> {t("simpleMode.pages.artifacts.factors")}</span>
        <span><strong>{strategies.length}</strong> {t("simpleMode.pages.artifacts.strategies")}</span>
        <span><strong>{backtests.length}</strong> {t("simpleMode.pages.artifacts.backtests")}</span>
      </div>
      <div className="qb-simple-list">
        {entries.map((entry) => (
          <article className="qb-simple-row" key={`${entry.kind}-${entry.id}`}>
            <div className="qb-simple-row__icon">{iconFor(entry.kind)}</div>
            <div className="qb-simple-row__body">
              <div className="qb-simple-row__title">{entry.title}</div>
              <div className="qb-simple-row__meta">{entry.kind} · {entry.meta}</div>
            </div>
            <div className="qb-simple-row__time">{formatTime(entry.createdAt)}</div>
          </article>
        ))}
        {!loading && entries.length === 0 ? <EmptyState>{t("simpleMode.pages.artifacts.empty")}</EmptyState> : null}
      </div>
    </SimplePageFrame>
  );
};
