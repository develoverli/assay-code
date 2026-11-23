import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles/globals.css";
import App from "./App";
import { hardenWebview } from "./lib/harden";
import { installClipboardFallback } from "./lib/clipboard";

// before the first render: a reload that lands mid-scan is the thing to prevent
hardenWebview();
// unlike hardening, this runs in dev too: a webview that won't paste won't paste
installClipboardFallback();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
