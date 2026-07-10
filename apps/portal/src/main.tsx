import { createRoot } from "react-dom/client";
import "@shuddl/design/tokens.css";
import "@shuddl/design/motion.css";
import type { ReactNode } from "react";
import { App } from "./App.js";
import { Status } from "./status.js";
import { EvidenceEmail } from "./evidence-email.js";

// The portal ships three canonical screens. A tiny ?screen switch lets the visual harness (and a
// human) reach the public status page and the evidence email without a router; the app default is
// the scoped portal board. status also has a #status hash entry (the portal's "Track" link).
function screen(): ReactNode {
  const params = new URLSearchParams(window.location.search);
  const which = params.get("screen") ?? (window.location.hash === "#status" ? "status" : "portal");
  if (which === "status") return <Status />;
  if (which === "email") return <EvidenceEmail />;
  return <App />;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(screen());
