import type { CSSProperties, FC } from "react";
import { useTranslation } from "../../i18n";
import { IdeEditorPane } from "./IdeEditorPane";
import { listIdeLeftTools } from "./ideLeftTools";

/**
 * IDE 左栏：默认仅代码编辑。工具数 > 1 时显示 Tab（见 ideLeftTools 注册表）。
 */
export const IdeLeftColumn: FC = () => {
  const { t } = useTranslation();
  const tools = listIdeLeftTools();
  const showTabs = tools.length > 1;

  return (
    <div style={styles.root} data-qb-ide-left-column>
      {showTabs ? (
        <div style={styles.tabsWrap} role="tablist" aria-label={t("ide.leftColumn.ariaLabel")}>
          <div className="qb-segmented qb-segmented--inline" style={styles.segmented}>
            {tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                role="tab"
                aria-selected
                className="qb-segmented__tab qb-segmented__tab--active"
              >
                {t(tool.titleKey)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div style={styles.body}>
        <IdeEditorPane />
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  tabsWrap: {
    flexShrink: 0,
    padding: "8px 10px 6px",
    borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-team-stage-bg, #0c0c0e)",
  },
  segmented: {
    width: "100%",
  },
  body: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
};
