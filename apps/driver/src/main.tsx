import { createRoot } from "react-dom/client";
import "@shuddl/design/tokens.css";
import "@shuddl/design/motion.css";
import { App } from "./App.js";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);

// REQ-061 — register the offline-first service worker. Fire-and-forget after load so it never blocks
// first paint; a failure (e.g. an unsupported context) degrades to an online-only app, never a crash.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline install is best-effort; the app still runs online */
    });
  });
}
