import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DunningQueue } from "./DunningQueue.js";

// WP-11 Task 7 (REQ-032) — the DUNNING draft queue view. Driven against the REAL api client with a stubbed
// global `fetch` (like App.test) so the send genuinely dispatches a POST WITH the Idempotency-Key the client
// attaches, and the held/sent state is proven HONEST end to end.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DRAFT = {
  draft_id: "msg:dunning:INV-9:reminder",
  invoice_id: "INV-9",
  party_id: "p-9",
  bucket: "reminder" as const,
  amount_cents: 100_000,
  due_ts: 0,
  days_overdue: 12,
  recipient: "billing@acme.example.com",
  subject: "REMINDER · Invoice INV-9 · $1,000.00",
  preview_html: "<div>reminder</div>",
};

let lastSendInit: RequestInit | null = null;

// Route the send POST vs the draft-list GET; capture the send's init to assert the Idempotency-Key header.
function stubFetch(sendBody: unknown): void {
  lastSendInit = null;
  const mock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/v1/dunning/") && url.endsWith("/send")) {
      lastSendInit = init ?? null;
      return Promise.resolve(jsonResponse(sendBody));
    }
    if (url.includes("/v1/dunning")) return Promise.resolve(jsonResponse({ drafts: [DRAFT] }));
    return Promise.resolve(jsonResponse({ code: "NOT_FOUND", message: "NOT FOUND" }, 404));
  });
  vi.stubGlobal("fetch", mock);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DunningQueue (REQ-032)", () => {
  it("renders the Collector's drafts — bucket, invoice, amount, aging, recipient", async () => {
    stubFetch({ status: "sent" });
    render(<DunningQueue onAuthError={vi.fn()} />);
    expect(await screen.findByText("INV-9")).toBeTruthy();
    expect(screen.getByText("REMINDER")).toBeTruthy();
    expect(screen.getByText("$1,000.00")).toBeTruthy();
    expect(screen.getByText("12D OVERDUE")).toBeTruthy();
    expect(screen.getByText("billing@acme.example.com")).toBeTruthy();
  });

  it("a SEND dispatches POST /v1/dunning/:id/send WITH an Idempotency-Key, then shows SENT", async () => {
    stubFetch({ status: "sent", invoice_id: "INV-9", bucket: "reminder", provider: "recording", provider_id: "x" });
    render(<DunningQueue onAuthError={vi.fn()} />);
    const btn = await screen.findByLabelText("send dunning for INV-9");
    fireEvent.click(btn);
    await screen.findByText("SENT");
    // the api client attached a FRESH Idempotency-Key to the human-initiated send (REQ-156)
    const headers = (lastSendInit?.headers ?? {}) as Record<string, string>;
    expect(headers["idempotency-key"]).toBeTruthy();
  });

  it("§1687 a tenant with NO drafts sees the empty state, not a blank panel", async () => {
    // The screen a NEW tenant meets first: the Collector has drafted nothing. Every existing case stubs
    // `{ drafts: [DRAFT] }`, so the `drafts.length === 0` arm was unreachable in the suite — making it
    // unreachable in the COMPONENT (replacing the condition with `false`) left command 100/100 green.
    // This view's own header records a prior white-screen in exactly this area, which is why the empty
    // path is worth a case rather than a reading.
    const mock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ drafts: [] })));
    vi.stubGlobal("fetch", mock);
    render(<DunningQueue onAuthError={vi.fn()} />);

    await screen.findByText("NO DUNNING DRAFTS");
    expect(screen.queryByLabelText(/^send dunning for/), "no row actions when there are no rows").toBeNull();
  });

  it("a HELD send shows the REAL held state — never a false SENT (honest hold)", async () => {
    stubFetch({ status: "held", reason: "send_failed_permanent", detail: "permanently failed" });
    render(<DunningQueue onAuthError={vi.fn()} />);
    const btn = await screen.findByLabelText("send dunning for INV-9");
    fireEvent.click(btn);
    await screen.findByText(/HELD/);
    expect(screen.queryByText("SENT")).toBeNull(); // never a false "SENT"
  });
});
