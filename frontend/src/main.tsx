import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./ide-theme.css";
import "./qb-themes.css";
import "./theme/transitions.css";
import "./theme/styles/glassmorphism.css";
import "./theme/styles/generative-art.css";
import "./theme/styles/industrial.css";
import "./theme/styles/neon-cyberpunk.css";
import "./theme/styles/bauhaus.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
