import type { CSSProperties, FC } from "react";
import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";
import { getHealth } from "./api/backend";
import { syncBackendUrlForDesktop } from "./api/packaged-backend";
import { isTauriEnv, tauriBackendStatus, tauriStartBackend } from "./api/tauri";
import { useAppStore } from "./store";
import { useAmbient3dTilt } from "./hooks/useAmbient3dTilt";

const App: FC = () => {
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);
  useAmbient3dTilt();

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
        await getHealth();
        lastConnected = true;
        setBackendConnected(true);
        setBackendHint(null);
      } catch {
        lastConnected = false;
        setBackendConnected(false);
        if (inTauri) {
          setBackendHint("内置后端未就绪，可点击顶部「重启后端」或稍候自动重试。");
        } else {
          setBackendHint("后端未连接：请在项目根目录启动 `bun run dev`。");
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
      setBackendHint("当前为 Web 模式，不会自动拉起后端，请先执行 `bun run dev`。");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void probeHealth();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, [setBackendConnected, setBackendHint]);

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
