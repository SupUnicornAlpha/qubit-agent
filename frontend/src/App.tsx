import type { CSSProperties, FC } from "react";
import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";
import { getHealth } from "./api/backend";
import { syncBackendUrlForDesktop } from "./api/packaged-backend";
import { isTauriEnv, tauriBackendStatus, tauriStartBackend } from "./api/tauri";
import { useAppStore } from "./store";
import { useTranslation } from "./i18n";

const App: FC = () => {
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);
  const { t, locale } = useTranslation();

  useEffect(() => {
    const CONNECTED_INTERVAL_MS = 15_000;
    const DISCONNECTED_INTERVAL_MS = 3_000;
    const HIDDEN_INTERVAL_MS = 60_000;
    const inTauri = isTauriEnv();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastConnected = false;

    const pickInterval = () => {
      if (document.visibilityState === "hidden") return HIDDEN_INTERVAL_MS;
      return lastConnected ? CONNECTED_INTERVAL_MS : DISCONNECTED_INTERVAL_MS;
    };

    const scheduleNext = () => {
      if (disposed) return;
      timer = setTimeout(() => {
        void probeHealth();
      }, pickInterval());
    };

    const probeHealth = async () => {
      if (disposed) return;
      try {
        if (inTauri) {
          const st = await tauriBackendStatus().catch(() => null);
          if (st && !st.running) {
            await tauriStartBackend().catch(() => null);
          }
        }
        const health = await getHealth();
        lastConnected = true;
        setBackendConnected(true);
        setBackendHint(
          health.status === "degraded"
            ? `后端在线 · 行情降级：${health.marketData?.message ?? "没有数据源通过 readiness"}`
            : null
        );
      } catch {
        lastConnected = false;
        setBackendConnected(false);
        if (inTauri) {
          setBackendHint(t("app.hint.tauriBackendNotReady"));
        } else {
          setBackendHint(t("app.hint.webBackendDisconnected"));
        }
      } finally {
        scheduleNext();
      }
    };

    const onVisibilityChange = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = null;
      void probeHealth();
    };

    if (isTauriEnv()) {
      syncBackendUrlForDesktop();
      setBackendHint(null);
      void tauriStartBackend();
    } else {
      setBackendHint(t("app.hint.webModeBootstrap"));
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void probeHealth();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
    };
    // 依赖 `locale` 是为了切换语言后立即用新文案刷新 hint。
  }, [setBackendConnected, setBackendHint, t, locale]);

  return (
    <div className="qb-app-root" style={styles.root}>
    <div className="qb-gh-bg-layer" aria-hidden>
      <span className="qb-gh-bg-layer__base" />
      <span className="qb-gh-bg-layer__orbs" />
      <span className="qb-gh-bg-layer__aurora" />
      <span className="qb-a3d-spatial-grid" />
      <span className="qb-gh-bg-layer__sweep" />
      <span className="qb-gh-bg-layer__wave" />
      <span className="qb-a3d-scene-deco" aria-hidden>
        <span className="qb-a3d-prism-shadow" />
        <span className="qb-a3d-prism" />
      </span>
    </div>
    <TopBar />
    <div className="qb-a3d-stage" style={styles.body}>
      <Sidebar />
      <MainContent />
    </div>
  </div>
  );
};

export default App;

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    minWidth: 0,
    maxWidth: "100vw",
    color: "var(--qb-body-fg, #e4e4e7)",
    overflow: "hidden",
  },
  body: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
};
