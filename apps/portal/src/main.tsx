import { createRoot } from "react-dom/client";
import "@shuddl/design/tokens.css";
import "@shuddl/design/motion.css";
import type { ReactNode } from "react";
import { App } from "./App.js";
import { Status } from "./status.js";
import { GuestQuote } from "./pages/GuestQuote.js";
import { EvidenceEmail } from "./evidence-email.js";
import { resolveRoute } from "./router.js";

// REQ-086/051 — the portal entry. A real (dependency-free) router replaces the old ?screen= switch: it maps
// the URL to one screen. The TWO public routes (/status/:cap, /quote) render WITHOUT a session — only the
// authed board (App) reads the session lens. The legacy ?screen= switch + the #status Track link still
// resolve (see router.ts), so the visual harness and existing links keep working.
function screen(): ReactNode {
  const route = resolveRoute(window.location);
  switch (route.name) {
    case "status":
      return <Status cap={route.cap} />;
    case "quote":
      return <GuestQuote />;
    case "email":
      return <EvidenceEmail />;
    case "board":
      return <App initialView={route.tab} />;
  }
}

const el = document.getElementById("root");
if (el) createRoot(el).render(screen());
