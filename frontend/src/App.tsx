import type { CSSProperties, FC } from "react";
import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";
import { getHealth } from "./api/backend";
import { isTauriEnv, tauriStartBackend } from "./api/tauri";
import { useAppStore } from "./store";

const App: FC = () => {
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);

  useEffect(() => {
    if (isTauriEnv()) {
      setBackendHint(null);
      void tauriStartBackend();
    } else {
      setBackendHint("当前为 Web 模式，不会自动拉起后端，请先执行 `bun run dev`。");
    }
    const timer = setInterval(() => {
      void getHealth()
        .then(() => {
          setBackendConnected(true);
          setBackendHint(null);
        })
        .catch(() => {
          setBackendConnected(false);
          if (!isTauriEnv()) {
            setBackendHint("后端未连接：请在项目根目录启动 `bun run dev`。");
          }
        });
    }, 1500);
    return () => clearInterval(timer);
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
