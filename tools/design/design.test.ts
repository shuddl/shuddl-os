import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";
import { auditTokens, readTokens, auditMotion, auditCaseAndDividers } from "./audit.js";

describe("contrast math (WCAG 2.x)", () => {
  it("black on white = 21:1", () => expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0));
  it("identical colors = 1:1", () => expect(contrastRatio("#D5D1CC", "#D5D1CC")).toBeCloseTo(1, 5));
});

describe("REQ-149 / A1: --signal-deep locked at >=4.5:1 on --field", () => {
  it("small-text red passes AA on greige", () => {
    const t = readTokens("packages/design/tokens.css");
    const deep = t["--signal-deep"];
    const field = t["--field"];
    if (!deep || !field) throw new Error("tokens missing");
    expect(contrastRatio(deep, field)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("REQ-145: five color tokens only", () => {
  it("token audit finds exactly the sanctioned palette", () => {
    const result = auditTokens("packages/design/tokens.css");
    expect(result.colorTokens).toEqual(["--field", "--signal", "--signal-deep", "--ink-dark", "--progress"]);
  });
});

describe("REQ-148: motion law", () => {
  it("flags a spring/parallax/particle/shimmer/rotate keyword in css/tsx", () => {
    for (const bad of [
      "transition: transform 200ms cubic-bezier(.34,1.56,.64,1);", // spring overshoot
      "animation: shimmer 1s infinite;",
      "background-attachment: fixed; /* parallax */",
      "transform: rotate(4deg);",
    ]) expect(auditMotion("x.tsx", bad).length).toBeGreaterThan(0);
  });
  it("passes reveal/count-up/opacity motion", () => {
    expect(auditMotion("x.tsx", "transition: opacity 600ms cubic-bezier(.16,1,.3,1);")).toEqual([]);
  });
  it("flags a keyframes/transition file that never references prefers-reduced-motion", () => {
    expect(auditMotion("anim.css", "@keyframes reveal { to { opacity: 1 } }").some(v => v.includes("reduced-motion"))).toBe(true);
  });
});

describe("REQ-147/146: dividers + case", () => {
  it("flags a border/divider thicker than 1px", () => {
    expect(auditCaseAndDividers("x.tsx", "border-bottom: 2px solid var(--signal);").some(v => v.includes("1px"))).toBe(true);
  });
  it("flags text-transform other than uppercase on a display/mono element", () => {
    expect(auditCaseAndDividers("x.tsx", "text-transform: capitalize;").some(v => v.includes("uppercase"))).toBe(true);
  });
});

describe("REQ-147: shadow + radius audits cover JSX camelCase inline styles", () => {
  it("flags a camelCase boxShadow drop shadow (the real bypass)", () => {
    expect(auditCaseAndDividers("x.tsx", `boxShadow: "0 2px 4px #123456"`).some(v => /shadow/i.test(v))).toBe(true);
  });
  it("passes boxShadow: none", () => {
    expect(auditCaseAndDividers("x.tsx", `boxShadow: "none"`)).toEqual([]);
  });
  it("flags a bare-number borderRadius > 4 (px implied)", () => {
    expect(auditCaseAndDividers("x.tsx", `borderRadius: 12`).some(v => v.includes("4px"))).toBe(true);
  });
  it("flags a string borderRadius > 4 and parses the max of a shorthand", () => {
    expect(auditCaseAndDividers("x.tsx", `borderRadius: "8px"`).some(v => v.includes("4px"))).toBe(true);
    expect(auditCaseAndDividers("x.tsx", `borderRadius: "8px 8px 0 0"`).some(v => v.includes("4px"))).toBe(true);
  });
  it("passes compliant radii (0, 2, 4, '4px')", () => {
    for (const ok of [`borderRadius: 0`, `borderRadius: 2`, `borderRadius: 4`, `borderRadius: "4px"`]) {
      expect(auditCaseAndDividers("x.tsx", ok)).toEqual([]);
    }
  });
  it("a JSX inline-style object with a shadow AND a 12px radius is fully flagged", () => {
    const jsx = `<div style={{ boxShadow: "0 2px 4px #123456", borderRadius: 12 }} />`;
    const out = auditCaseAndDividers("Card.tsx", jsx);
    expect(out.some(v => /shadow/i.test(v))).toBe(true);
    expect(out.some(v => v.includes("4px"))).toBe(true);
  });
});

describe("REQ-148: motion audit covers JSX camelCase inline styles", () => {
  it("flags camelCase backgroundAttachment: fixed", () => {
    expect(auditMotion("x.tsx", `backgroundAttachment: "fixed"`).length).toBeGreaterThan(0);
  });
  it("still covers rotate + spring written as JSX string values", () => {
    expect(auditMotion("x.tsx", `transform: "rotate(4deg)"`).length).toBeGreaterThan(0);
    expect(auditMotion("x.tsx", `transition: "transform 200ms cubic-bezier(.34,1.56,.64,1)"`).length).toBeGreaterThan(0);
  });
});
