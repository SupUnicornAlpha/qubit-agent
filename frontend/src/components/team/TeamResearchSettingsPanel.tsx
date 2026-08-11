/**
 * 研究设置表单：供左栏工作流视图与右栏 Run 条复用。
 */
import type { CSSProperties, FC } from "react";
import type { AgentLoopKind } from "../../api/types";
import type { ResearchInstrumentUi, ResearchScopeMode } from "../../lib/researchScope";

export type TeamResearchSettingsPanelProps = {
  styles: Record<string, CSSProperties>;
  compact?: boolean;
  scopeMode: ResearchScopeMode;
  onScopeModeChange: (mode: ResearchScopeMode) => void;
  researchInstrument: ResearchInstrumentUi;
  onResearchInstrumentChange: (instrument: ResearchInstrumentUi) => void;
  roleReasoner: AgentLoopKind;
  onRoleReasonerChange: (kind: AgentLoopKind) => void;
  ticker: string;
  onTickerChange: (v: string) => void;
  basketTickers: string;
  onBasketTickersChange: (v: string) => void;
  sectorName: string;
  onSectorNameChange: (v: string) => void;
  sectorPeers: string;
  onSectorPeersChange: (v: string) => void;
  exploreTheme: string;
  onExploreThemeChange: (v: string) => void;
  exploreCandidates: string;
  onExploreCandidatesChange: (v: string) => void;
  optionUnderlying: string;
  onOptionUnderlyingChange: (v: string) => void;
  optionContract: string;
  onOptionContractChange: (v: string) => void;
  optionExpiry: string;
  onOptionExpiryChange: (v: string) => void;
  optionStrike: string;
  onOptionStrikeChange: (v: string) => void;
  optionRight: "call" | "put" | "";
  onOptionRightChange: (v: "call" | "put" | "") => void;
  promptTemplateId: string;
  onApplyPromptTemplate: (id: string) => void;
  availablePromptTemplates: Array<{ id: string; label: string; summary: string }>;
  teamAnalysisContext: string;
  onTeamAnalysisContextChange: (v: string) => void;
  onClearPromptTemplateId: () => void;
  scopeModeLabel: (mode: ResearchScopeMode) => string;
  instrumentLabel: (instrument: ResearchInstrumentUi) => string;
};

export const TeamResearchSettingsPanel: FC<TeamResearchSettingsPanelProps> = ({
  styles: teamStyles,
  compact = false,
  scopeMode,
  onScopeModeChange,
  researchInstrument,
  onResearchInstrumentChange,
  roleReasoner,
  onRoleReasonerChange,
  ticker,
  onTickerChange,
  basketTickers,
  onBasketTickersChange,
  sectorName,
  onSectorNameChange,
  sectorPeers,
  onSectorPeersChange,
  exploreTheme,
  onExploreThemeChange,
  exploreCandidates,
  onExploreCandidatesChange,
  optionUnderlying,
  onOptionUnderlyingChange,
  optionContract,
  onOptionContractChange,
  optionExpiry,
  onOptionExpiryChange,
  optionStrike,
  onOptionStrikeChange,
  optionRight,
  onOptionRightChange,
  promptTemplateId,
  onApplyPromptTemplate,
  availablePromptTemplates,
  teamAnalysisContext,
  onTeamAnalysisContextChange,
  onClearPromptTemplateId,
  scopeModeLabel,
  instrumentLabel,
}) => {
  return (
    <div
      style={compact ? styles.compactRoot : teamStyles.leftRailSettings}
      data-qb-team-research-settings
    >
      {!compact ? (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--qb-team-meta, #a1a1aa)",
            marginBottom: 10,
          }}
        >
          研究与工作流
        </div>
      ) : (
        <div style={styles.compactTitle}>研究设置</div>
      )}
      <div style={teamStyles.field}>
        <label style={teamStyles.label}>研究范围</label>
        <select
          style={teamStyles.input}
          value={scopeMode}
          onChange={(e) => onScopeModeChange(e.target.value as ResearchScopeMode)}
        >
          <option value="single">单标的</option>
          <option value="basket">多标的篮子</option>
          <option value="sector">板块</option>
          <option value="explore">自由探索（无固定标的）</option>
        </select>
      </div>
      <div style={{ ...teamStyles.field, marginTop: 8 }}>
        <label style={teamStyles.label}>工具类型</label>
        <select
          style={teamStyles.input}
          value={researchInstrument}
          onChange={(e) =>
            onResearchInstrumentChange(e.target.value as ResearchInstrumentUi)
          }
        >
          <option value="equity_long">股票多头</option>
          <option value="equity_short">股票做空</option>
          <option value="option">期权</option>
          <option value="future">期货</option>
          <option value="crypto">加密资产</option>
        </select>
      </div>
      <div style={{ ...teamStyles.field, marginTop: 8 }}>
        <label style={teamStyles.label}>Agent 底座</label>
        <select
          style={teamStyles.input}
          value={roleReasoner}
          onChange={(e) => onRoleReasonerChange(e.target.value as AgentLoopKind)}
        >
          <option value="native">自研（进程内 ReAct）</option>
          <option value="claude_cli">Claude CLI</option>
          <option value="codex_cli">Codex CLI</option>
        </select>
        {!compact ? (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            每个角色单轮推理用的引擎；Orchestrator 按需派发专家，CLI 不可用时自动回退自研。
          </div>
        ) : null}
      </div>
      {scopeMode === "single" ? (
        <div style={{ ...teamStyles.field, marginTop: 8 }}>
          <label style={teamStyles.label}>标的代码</label>
          <input
            style={teamStyles.input}
            value={ticker}
            onChange={(e) => onTickerChange(e.target.value)}
            placeholder={
              researchInstrument === "option"
                ? "标的或 OCC 合约"
                : researchInstrument === "future"
                  ? "e.g. ES=F / GC=F / ESH5"
                  : researchInstrument === "crypto"
                    ? "e.g. BTCUSDT / ETH/USDT"
                    : "e.g. AAPL / 600519"
            }
          />
        </div>
      ) : null}
      {scopeMode === "basket" ? (
        <div style={{ ...teamStyles.field, marginTop: 8 }}>
          <label style={teamStyles.label}>篮子标的（逗号分隔，至少 2 个）</label>
          <textarea
            style={teamStyles.textarea}
            rows={2}
            value={basketTickers}
            onChange={(e) => onBasketTickersChange(e.target.value)}
            placeholder="e.g. AAPL, MSFT, NVDA"
          />
        </div>
      ) : null}
      {scopeMode === "sector" ? (
        <>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>板块名称</label>
            <input
              style={teamStyles.input}
              value={sectorName}
              onChange={(e) => onSectorNameChange(e.target.value)}
              placeholder="e.g. 半导体 / 新能源"
            />
          </div>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>成分股（逗号分隔，必填）</label>
            <textarea
              style={teamStyles.textarea}
              rows={2}
              value={sectorPeers}
              onChange={(e) => onSectorPeersChange(e.target.value)}
              placeholder="e.g. NVDA, AMD, AVGO"
            />
          </div>
        </>
      ) : null}
      {scopeMode === "explore" ? (
        <>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>研究主题（必填，越具体越好）</label>
            <textarea
              style={teamStyles.textarea}
              rows={2}
              value={exploreTheme}
              onChange={(e) => onExploreThemeChange(e.target.value)}
              placeholder="e.g. AI 推理芯片的轮动机会 / 美联储会议前后的避险标的"
            />
          </div>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>
              候选标的（可选，留空则由 Orchestrator 自主筛选）
            </label>
            <textarea
              style={teamStyles.textarea}
              rows={2}
              value={exploreCandidates}
              onChange={(e) => onExploreCandidatesChange(e.target.value)}
              placeholder="可写也可留空，e.g. NVDA, AMD, AVGO, TSM"
            />
          </div>
        </>
      ) : null}
      {researchInstrument === "option" && scopeMode === "single" ? (
        <div style={{ ...teamStyles.field, marginTop: 8 }}>
          <label style={teamStyles.label}>期权（可选）</label>
          <input
            style={teamStyles.input}
            value={optionUnderlying}
            onChange={(e) => onOptionUnderlyingChange(e.target.value)}
            placeholder="标的 NVDA"
          />
          <input
            style={{ ...teamStyles.input, marginTop: 6 }}
            value={optionContract}
            onChange={(e) => onOptionContractChange(e.target.value)}
            placeholder="合约 OCC"
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            <input
              style={{ ...teamStyles.input, flex: "1 1 90px" }}
              value={optionExpiry}
              onChange={(e) => onOptionExpiryChange(e.target.value)}
              placeholder="到期"
            />
            <input
              style={{ ...teamStyles.input, flex: "1 1 70px" }}
              value={optionStrike}
              onChange={(e) => onOptionStrikeChange(e.target.value)}
              placeholder="行权价"
            />
            <select
              style={{ ...teamStyles.input, flex: "0 0 72px" }}
              value={optionRight}
              onChange={(e) => onOptionRightChange(e.target.value as "call" | "put" | "")}
            >
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </div>
        </div>
      ) : null}
      <div style={{ ...teamStyles.field, marginTop: 10 }}>
        <label style={teamStyles.label}>分析提示模板（可选，选中后自动填入下方文本框）</label>
        <select
          style={teamStyles.input}
          value={promptTemplateId}
          onChange={(e) => onApplyPromptTemplate(e.target.value)}
        >
          <option value="">— 不使用模板 —</option>
          {availablePromptTemplates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} · {t.summary}
            </option>
          ))}
        </select>
        {availablePromptTemplates.length === 0 ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--qb-team-muted-fg, #71717a)",
              marginTop: 4,
            }}
          >
            当前 {scopeModeLabel(scopeMode)} + {instrumentLabel(researchInstrument)}{" "}
            组合暂无内置模板，可自行填写下方提示。
          </div>
        ) : null}
      </div>
      <div style={{ ...teamStyles.field, marginTop: 10 }}>
        <label style={teamStyles.label}>分析提示（可选，覆盖默认）</label>
        <textarea
          style={teamStyles.textarea}
          rows={compact ? 4 : 6}
          value={teamAnalysisContext}
          onChange={(e) => {
            onTeamAnalysisContextChange(e.target.value);
            if (promptTemplateId) onClearPromptTemplateId();
          }}
          placeholder={`留空则使用默认分析提示。当前：${scopeModeLabel(scopeMode)} · ${instrumentLabel(researchInstrument)}`}
        />
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  compactRoot: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    marginTop: 8,
    paddingTop: 8,
    borderTop: "1px solid #27272a",
  },
  compactTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: "#a1a1aa",
    marginBottom: 8,
  },
};
