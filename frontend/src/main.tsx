import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initI18n } from "./i18n";
import "./ide-theme.css";
import "./theme/tokyo-night-editor.css";
import "./qb-themes.css";
import "./theme/quant-studio.css";
import "./theme/transitions.css";
import "./theme/styles/feishu-clean.css";
import "./theme/styles/industrial.css";
import "./theme/styles/bauhaus.css";
import "./theme/config-center.css";
import "./theme/chat-ui.css";
import "./theme/styles/sci-fi-hud.css";
import "./theme/styles/comic-book.css";
import "./theme/styles/news-page.css";
import "./theme/topology-canvas.css";
import "./theme/styles/pixel-office.css";
import "./theme/team-research-canvas.css";
import "./theme/monitor-industrial.css";
import "./theme/team-industrial.css";
import "./theme/config-industrial.css";
import "./theme/quant-industrial.css";
import "./theme/quant-comic-book.css";
import "./theme/quant-sci-fi-hud.css";
import "./theme/simple-mode.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

initI18n();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
