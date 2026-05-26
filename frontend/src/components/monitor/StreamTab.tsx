/**
 * 监控 · 实时流 tab：从 MonitorDashboard.tsx 拆出（scope === "stream" 块）。
 * 纯机械拆分。
 */
import type { FC } from "react";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";
import { styles } from "./monitor-shared";

export type StreamTabProps = {
  monitorStreamGroups: ReturnType<typeof groupStreamEventsByRun>;
  clearStreamEvents: () => void;
};

export const StreamTab: FC<StreamTabProps> = ({ monitorStreamGroups, clearStreamEvents }) => {
  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        实时流 · 全局 SSE（按 run 折叠）
      </h3>
      <div style={styles.form}>
        <button className="qb-btn-secondary" type="button" onClick={() => clearStreamEvents()}>
          清空本地流
        </button>
      </div>
      <div style={styles.streamList}>
        {monitorStreamGroups.length === 0 ? (
          <div style={styles.empty}>暂无事件，在「整体」创建并订阅工作流后将在此显示</div>
        ) : (
          monitorStreamGroups
            .slice()
            .sort((a, b) => b.at - a.at)
            .slice(0, 20)
            .map((g) => <StreamTimelineGroupCard key={`${g.workflowRunId}-${g.runId}`} item={g} />)
        )}
      </div>
    </>
  );
};
