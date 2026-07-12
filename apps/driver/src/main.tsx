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

// REQ-164 ([CONFIRM]/pilot): the app is INSTALLABLE (Web App Manifest + this service worker → no app store).
// The driver ONBOARDING KIT (QR install + magic link + printed card) and the acceptance bar — a real tenant-0
// driver installs and completes a gated stop UNASSISTED — are [CONFIRM]/pilot, proven on video at pilot, never
// from CI.
// REQ-006 ([CONFIRM]/pilot — driver half; WP-10 CSR half): the zero-instruction driver test (Doc00 L6). The
// gate-as-training mechanism is built (one-question-one-button gated flow; a disabled ADVANCE teaches the step),
// but "a real driver completes unassisted on video" is the [CONFIRM]/pilot acceptance result. REQ-006's other
// half — the 10-minute CSR self-serve test — is WP-10 (Portal), not this surface.
// REQ-061 — register the offline-first service worker. Fire-and-forget after load so it never blocks
// first paint; a failure (e.g. an unsupported context) degrades to an online-only app, never a crash.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline install is best-effort; the app still runs online */
    });
  });
}
