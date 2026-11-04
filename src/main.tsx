import { AppearanceRuntime } from "./ControlAppearance";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MirrorWindow from "./MirrorWindow";
import Tooltip from "./Tooltip";

const label = getCurrentWindow().label;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {label.startsWith("mirror-") ? <MirrorWindow /> : <App />}
    <AppearanceRuntime />
    <Tooltip />
  </React.StrictMode>,
);
