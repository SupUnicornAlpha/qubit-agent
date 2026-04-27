import type { CSSProperties, FC } from "react";
import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";
import { getHealth } from "./api/backend";
import { tauriStartBackend } from "./api/tauri";
import { useAppStore } from "./store";

const App: FC = () => {
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);

  useEffect(() => {
    void tauriStartBackend();
    const timer = setInterval(() => {
      void getHealth()
        .then(() => setBackendConnected(true))
        .catch(() => setBackendConnected(false));
    }, 1500);
    return () => clearInterval(timer);
  }, [setBackendConnected]);

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
