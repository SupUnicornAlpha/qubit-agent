import type { CSSProperties, FC } from "react";
import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";
import { getHealth } from "./api/backend";
import { isTauriEnv, tauriBackendStatus, tauriStartBackend } from "./api/tauri";
import { useAppStore } from "./store";

const App: FC = () => {
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);

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
          // Prefer local status in Tauri to reduce HTTP probing.
          const status = await tauriBackendStatus();
          if (!status.running) throw new Error("backend process not running");
        }
        await getHealth();
        lastConnected = true;
        setBackendConnected(true);
        setBackendHint(null);
      } catch {
        lastConnected = false;
        setBackendConnected(false);
        if (!inTauri) {
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
    <div style={styles.root}>
      <TopBar />
      <div style={styles.body}>
        <Sidebar />
        <MainContent />
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#0d0d0f",
    color: "#e4e4e7",
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
};

export default App;
