import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./ide-theme.css";
import "./theme/tokyo-night-editor.css";
import "./qb-themes.css";
import "./theme/transitions.css";
import "./theme/styles/glass-holographic.css";
import "./theme/styles/retro-futurism.css";
import "./theme/styles/industrial.css";
import "./theme/styles/neon-cyberpunk.css";
import "./theme/styles/bauhaus.css";
import "./theme/config-center.css";
import "./theme/chat-ui.css";
import "./theme/styles/sci-fi-hud.css";
import "./theme/styles/comic-book.css";
import "./theme/styles/anti-design.css";
import "./theme/styles/blueprint.css";
import "./theme/styles/hand-drawn-fabric.css";
import "./theme/styles/ambient-3d.css";
import "./theme/styles/biophilic.css";
import "./theme/styles/news-page.css";
import "./theme/topology-canvas.css";
import "./theme/team-research-canvas.css";
import "./theme/glass-holographic-pages.css";
import "./theme/monitor-blueprint.css";
import "./theme/monitor-glass-holographic.css";
import "./theme/monitor-industrial.css";
import "./theme/team-industrial.css";
import "./theme/config-industrial.css";
import "./theme/monitor-ambient-3d.css";
import "./theme/quant-industrial.css";
import "./theme/quant-blueprint.css";
import "./theme/quant-glass-holographic.css";
import "./theme/quant-neon-cyberpunk.css";
import "./theme/quant-ambient-3d.css";
import "./theme/quant-biophilic.css";
import "./theme/quant-comic-book.css";
import "./theme/quant-sci-fi-hud.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
