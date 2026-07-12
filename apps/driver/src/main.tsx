import { createRoot } from "react-dom/client";
import "@shuddl/design/tokens.css";
import "@shuddl/design/motion.css";
import { App } from "./App.js";
import { requestPersistentStorage } from "./session.js";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);

// REQ-016 — ask the browser to retain our IndexedDB (device_seq ceiling + offline queue) so eviction
// can't reset nextSeq and cause a silent merge-drop. Best-effort, fire-and-forget; a denial is fine.
void requestPersistentStorage();

// REQ-061 — register the offline-first service worker. Fire-and-forget after load so it never blocks
// first paint; a failure (e.g. an unsupported context) degrades to an online-only app, never a crash.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline install is best-effort; the app still runs online */
    });
  });
}
