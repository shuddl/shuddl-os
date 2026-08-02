import { describe, it, expect } from "vitest";
import { buildInterchange } from "../src/writer.js";
import { build214 } from "../src/build-214.js";
import { build990 } from "../src/build-990.js";

// 2026-08-01 audit (code-markers, latent at the EDI flip): ISA09/ISA10/GS04/GS05 were hard-coded to
// 000101/0000 for byte-stability, and send-time stamping rewrote only control numbers — so the day the
// CONFIRM-gated transport flips live, every 214/990 would transmit a 2000-01-01 interchange date, which
// partner VANs commonly reject. The fix follows the control-number seam exactly: `sentAt` (epoch ms) is a
// SEND-TIME input the sweep stamps in the same place it stamps ISA13/GS06 — the writer stays PURE (no
// Date.now inside; same input → same bytes) and fixtures stay byte-stable by omitting it.

const BASE = {
  isaControl: "42",
  gsControl: "77",
  receiver: "MEGA",
  data: ["B1*MEGA*shp-1*A"],
};

// 2026-08-01T14:30:00Z — a fixed instant, so these assertions are themselves deterministic.
const SENT_AT = Date.UTC(2026, 7, 1, 14, 30, 0);

describe("sentAt — real interchange dates at send, fixed constants without (REQ-200/REQ-201)", () => {
  it("without sentAt the envelope keeps the byte-stable fixture constants (nothing regresses)", () => {
    const out = buildInterchange({ docType: "990", gsCode: "GF", ...BASE });
    expect(out).toContain("*000101*0000*U*");
    expect(out).toContain("GS*GF*SHUDDL*MEGA*20000101*0000*77*X*004010");
  });

  it("with sentAt the ISA09/ISA10 and GS04/GS05 carry the real UTC date and time", () => {
    const out = buildInterchange({ docType: "990", gsCode: "GF", ...BASE, sentAt: SENT_AT });
    expect(out).toContain("*260801*1430*U*"); // ISA09 YYMMDD, ISA10 HHMM
    expect(out).toContain("GS*GF*SHUDDL*MEGA*20260801*1430*77*X*004010"); // GS04 CCYYMMDD, GS05 HHMM
  });

  it("the writer stays pure: the same sentAt yields identical bytes", () => {
    const a = buildInterchange({ docType: "990", gsCode: "GF", ...BASE, sentAt: SENT_AT });
    const b = buildInterchange({ docType: "990", gsCode: "GF", ...BASE, sentAt: SENT_AT });
    expect(a).toBe(b);
  });

  it("build214 threads sentAt through to the envelope", () => {
    const view = {
      shipmentRef: "shp-214",
      partnerScac: "MEGA",
      isaControl: "42",
      gsControl: "77",
      stops: [{ statusCode: "X3", ts: "2026-07-20T08:00:00Z" }],
      sentAt: SENT_AT,
    };
    expect(build214(view)).toContain("*260801*1430*U*");
  });

  it("build990 threads sentAt through to the envelope", () => {
    const r = { partnerScac: "MEGA", shipmentRef: "shp-990", action: "A" as const, isaControl: "42", gsControl: "77", sentAt: SENT_AT };
    expect(build990(r)).toContain("GS*GF*SHUDDL*MEGA*20260801*1430*77*X*004010");
  });
});
