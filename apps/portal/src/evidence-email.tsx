import { EvidenceEmailView } from "@shuddl/agents/biller/evidence-email-view";
import type { EvidenceEmailData } from "@shuddl/agents/biller/evidence-email-view";

// THE EVIDENCE EMAIL (doc 07 §03) — ONE SOURCE: the shared, data-wired composition in
// @shuddl/agents (REQ-087/129). The Biller sends renderEvidenceEmail(data).html (tokens
// inlined for mail clients); the portal renders the very same VIEW here, where the app
// stylesheet dereferences the var(--token) references. The import is the VIEW SUBPATH on
// purpose: it keeps react-dom/server + the biller composition core out of the PWA bundle.
// Deterministic fictional fixture — no photo urls, so the documentary placeholder slots keep
// the canonical screenshot stable. The full-viewport greige ground lives HERE (min-height is
// meaningless in an email, so the shared view does not carry it).

const FIXTURE: EvidenceEmailData = {
  shipment_ref: "SHP-40206",
  delivered_at: "2026-07-10 · 14:32 MT",
  signed_by: "J. NAVARRO · RECEIVING",
  location: "DENVER, CO 80216",
  invoice_ref: "INV-40206",
  total_cents: 148_000,
  photos: {},
  referral_url: "https://shuddl.example/ship-like-this?ref=SHP-40206",
};

export function EvidenceEmail(): React.JSX.Element {
  return (
    <main style={{ minHeight: "100vh", background: "var(--field)" }}>
      <EvidenceEmailView data={FIXTURE} />
    </main>
  );
}
