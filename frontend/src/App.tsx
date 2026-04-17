import type { FC } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { MainContent } from "./components/layout/MainContent";

const App: FC = () => {
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

const styles: Record<string, React.CSSProperties> = {
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
