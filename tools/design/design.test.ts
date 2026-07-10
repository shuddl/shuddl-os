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
