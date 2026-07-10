import { useEffect, useState, type ReactNode } from "react";

// Motion primitives (doc 07 §05, REQ-148). Only two exist: a fade-up Reveal and an eased
// CountUp. Both defer to prefers-reduced-motion — the reveal via the CSS guard in motion.css,
// the count-up via JS (values just appear). No springs, no shimmer, no decoration.

/** True when the platform asks for reduced motion — or when there is no matchMedia to ask
 * (SSR / test env): in both cases we skip the tween and show the final value at once. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface RevealProps {
  children: ReactNode;
  className?: string;
}

/** Fade-up entrance. The animation + its reduced-motion rest state live in motion.css
 * (`.shuddl-reveal`); import "@shuddl/design/motion.css" to activate it. Content is always
 * in the DOM, so nothing is hidden when motion is off. */
export function Reveal({ children, className }: RevealProps): React.JSX.Element {
  const cls = className ? `shuddl-reveal ${className}` : "shuddl-reveal";
  return <div className={cls}>{children}</div>;
}

export interface CountUpProps {
  to: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}

/** An eased count-up (ease-out cubic, ~1.2–1.8s). Under reduced-motion the final value is
 * rendered immediately. Display type, `--signal` — never teal (teal is map-progress-only). */
export function CountUp({ to, duration = 1500, format, className }: CountUpProps): React.JSX.Element {
  const [value, setValue] = useState<number>(() => (prefersReducedMotion() ? to : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setValue(Math.round(to * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, duration]);

  const text = format ? format(value) : String(value);
  return (
    <span
      className={className}
      style={{ fontFamily: "var(--display)", fontWeight: 700, letterSpacing: "-0.015em", color: "var(--signal)" }}
    >
      {text}
    </span>
  );
}
