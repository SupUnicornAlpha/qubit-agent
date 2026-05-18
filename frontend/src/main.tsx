import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./ide-theme.css";
import "./theme/tokyo-night-editor.css";
import "./qb-themes.css";
import "./theme/transitions.css";
import "./theme/styles/glassmorphism.css";
import "./theme/styles/retro-futurism.css";
import "./theme/styles/industrial.css";
import "./theme/styles/neon-cyberpunk.css";
import "./theme/styles/bauhaus.css";
import "./theme/styles/sci-fi-hud.css";
import "./theme/styles/comic-book.css";
import "./theme/styles/news-page.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
