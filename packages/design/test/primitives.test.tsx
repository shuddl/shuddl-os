import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Chip, CountUp, Display, ErrorState, Loading, Metric, Reveal } from "../src/index.js";

describe("design primitives (doc 07 §01, REQ-146/147/115)", () => {
  it("Display renders uppercase via CSS text-transform, DOM stays normal-case (A5)", () => {
    const { getByText } = render(<Display size="hero">Board</Display>);
    const el = getByText("Board"); // DOM text is normal case
    expect(el.textContent).toBe("Board");
    expect(getComputedStyle(el).textTransform).toBe("uppercase");
  });

  it("ErrorState shows FAILED + a retry button (REQ-115)", () => {
    const onRetry = vi.fn();
    const { getByText } = render(<ErrorState onRetry={onRetry} />);
    getByText("FAILED");
    getByText(/retry/i).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("Chip has no radius > 4px and only token colors (REQ-147)", () => {
    const { getByText } = render(<Chip>In Transit</Chip>);
    const el = getByText("In Transit");
    const radius = Number.parseFloat(getComputedStyle(el).borderRadius || "0");
    expect(radius).toBeLessThanOrEqual(4);
    const style = el.getAttribute("style") ?? "";
    expect(style).toContain("var(--"); // every color is a token reference
    expect(style).not.toContain("#"); // never a raw hex
    expect(el.textContent).toBe("In Transit"); // A5 — DOM not pre-uppercased
  });

  it("Loading shows the muted SYNCING label, no skeleton (doc 07 §01)", () => {
    const { getByText } = render(<Loading />);
    getByText("SYNCING");
  });
});

describe("motion primitives honor reduced-motion (REQ-148)", () => {
  function mockReducedMotion(reduce: boolean): void {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: reduce,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  }
  afterEach(() => {
    // jsdom ships no matchMedia; drop the mock so each test starts clean.
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("CountUp with reduced-motion shows the final value immediately", () => {
    mockReducedMotion(true);
    const { getByText } = render(<CountUp to={504} />);
    getByText("504");
  });

  it("Metric shows its value immediately when matchMedia is unavailable (SSR/no-op)", () => {
    const { getByText } = render(<Metric label="Loads Today" value={48} />);
    getByText("48");
    getByText("Loads Today");
  });

  it("Reveal always renders its children (the fade-up is CSS, content is present)", () => {
    mockReducedMotion(true);
    const { getByText } = render(
      <Reveal>
        <span>Cargo</span>
      </Reveal>,
    );
    getByText("Cargo");
  });
});
