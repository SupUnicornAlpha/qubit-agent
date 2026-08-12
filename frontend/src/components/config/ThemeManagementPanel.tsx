import type { ChangeEvent, CSSProperties, FC } from "react";
import { useEffect, useState } from "react";
import { type UiStyleId, useAppStore } from "../../store";
import vistaGlassTheme from "../../theme/vista-glass.theme.json";
import {
  installThemePack,
  listThemeStyles,
  subscribeThemeStyles,
  uninstallThemePack,
  type ThemeStyleDefinition,
} from "../../theme/theme-registry";

/** IDE 设置中的主题管理：安装、切换、更新和卸载均在这里完成。 */
export const ThemeManagementPanel: FC = () => {
  const activeStyle = useAppStore((state) => state.uiStyle);
  const setUiStyle = useAppStore((state) => state.setUiStyle);
  const [styles, setStyles] = useState<ThemeStyleDefinition[]>(() => listThemeStyles());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => subscribeThemeStyles(() => setStyles(listThemeStyles())), []);

  const install = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const manifest = installThemePack(JSON.parse(await file.text()));
      setUiStyle(manifest.id);
      setMessage(`已安装 ${manifest.name} ${manifest.version}，并切换到该主题。`);
    } catch (error) {
      setMessage(`导入失败：${error instanceof Error ? error.message : "主题包无效"}`);
    }
  };

  const installVistaSample = () => {
    const manifest = installThemePack(vistaGlassTheme);
    setUiStyle(manifest.id);
    setMessage("已安装并切换到 Vista Glass 示例主题。");
  };

  const remove = (style: ThemeStyleDefinition) => {
    if (style.builtin || !window.confirm(`卸载主题「${style.name}」？`)) return;
    uninstallThemePack(style.id);
    if (activeStyle === style.id) setUiStyle("default");
    setMessage(`已卸载 ${style.name}。`);
  };

  return (
    <section style={stylesCss.panel} aria-labelledby="theme-management-title">
      <header style={stylesCss.header}>
        <div>
          <h3 id="theme-management-title" style={stylesCss.title}>主题管理</h3>
          <p style={stylesCss.subtitle}>
            像 IDE 一样集中管理界面主题。主题包是本机安装的 JSON 配置，不运行脚本；量化工坊会读取同一套主题令牌。
          </p>
        </div>
        <div style={stylesCss.actions}>
          <button type="button" className="qb-btn-secondary" onClick={installVistaSample}>
            安装 Vista Glass 示例
          </button>
          <label className="qb-btn-primary-brand" style={stylesCss.importButton}>
            导入主题包
            <input type="file" accept="application/json,.json" hidden onChange={(event) => void install(event)} />
          </label>
        </div>
      </header>

      {message ? <div style={stylesCss.notice} role="status">{message}</div> : null}

      <div style={stylesCss.grid}>
        {styles.map((style) => {
          const active = style.id === activeStyle;
          return (
            <article key={style.id} style={{ ...stylesCss.card, ...(active ? stylesCss.cardActive : null) }}>
              <div style={stylesCss.cardTop}>
                <div>
                  <strong>{style.name}</strong>
                  <div style={stylesCss.meta}>
                    {style.builtin ? "内置主题" : `已安装 · v${style.version ?? "—"}`} · {style.colorScheme ?? "自适应"}
                  </div>
                </div>
                <span style={{ ...stylesCss.badge, ...(active ? stylesCss.badgeActive : null) }}>
                  {active ? "当前" : style.builtin ? "内置" : "已安装"}
                </span>
              </div>
              <code style={stylesCss.id}>{style.id}</code>
              <div style={stylesCss.cardActions}>
                <button
                  type="button"
                  className={active ? "qb-btn-secondary" : "qb-btn-primary-brand"}
                  onClick={() => setUiStyle(style.id as UiStyleId)}
                  disabled={active}
                >
                  {active ? "正在使用" : "应用主题"}
                </button>
                {!style.builtin ? (
                  <button type="button" className="qb-btn-secondary" onClick={() => remove(style)}>
                    卸载
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <p style={stylesCss.footer}>
        导入相同 id 的 JSON 即可升级主题。主题格式与量化令牌说明见仓库 docs/theme-packs.md。
      </p>
    </section>
  );
};

const stylesCss: Record<string, CSSProperties> = {
  panel: { padding: "4px 0 20px", color: "var(--qb-body-fg)" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    flexWrap: "wrap",
    paddingBottom: 16,
    borderBottom: "1px solid var(--qb-separator)",
  },
  title: { margin: 0, fontSize: 18 },
  subtitle: { margin: "6px 0 0", maxWidth: 720, color: "var(--qb-main-meta)", fontSize: 12, lineHeight: 1.6 },
  actions: { display: "flex", gap: 8, flexWrap: "wrap" },
  importButton: { display: "inline-flex", alignItems: "center", cursor: "pointer" },
  notice: {
    margin: "14px 0",
    padding: "9px 11px",
    border: "1px solid var(--qb-main-card-border)",
    borderLeft: "3px solid var(--qb-blue)",
    background: "var(--qb-tint)",
    fontSize: 12,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, marginTop: 16 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    minWidth: 0,
    padding: 14,
    border: "1px solid var(--qb-main-card-border)",
    borderRadius: "var(--qb-radius-md, 8px)",
    background: "var(--qb-main-card-bg)",
  },
  cardActive: { borderColor: "var(--qb-blue)", boxShadow: "0 0 0 1px var(--qb-blue)" },
  cardTop: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" },
  meta: { marginTop: 4, color: "var(--qb-main-meta)", fontSize: 11 },
  badge: { padding: "2px 7px", borderRadius: 999, background: "var(--qb-tint)", color: "var(--qb-main-meta)", fontSize: 10 },
  badgeActive: { background: "var(--qb-blue)", color: "#fff" },
  id: { color: "var(--qb-main-meta)", fontSize: 11, overflowWrap: "anywhere" },
  cardActions: { display: "flex", gap: 8, marginTop: "auto" },
  footer: { margin: "16px 0 0", color: "var(--qb-main-meta)", fontSize: 11 },
};
