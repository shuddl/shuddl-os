import { useState, type ReactNode } from "react";
import { CountUp } from "./motion.js";

// The doc-07 §01 component vocabulary as React 19 primitives. Every one is audit-clean:
// colors are only `var(--token)`, uppercase is CSS `text-transform` (A5 — the DOM string
// stays normal-case so screen readers get real words), dividers are 1px, radius ≤4px, no
// shadows/gradients/teal. Small text on --field uses --signal-deep (locked ≥4.5:1); display
// type ≥18px uses --signal.

// ── Display — monumental condensed type ────────────────────────────────────────────────────
export type DisplaySize = "hero" | "section" | "sub" | "metric";
const DISPLAY_PX: Record<DisplaySize, number> = { hero: 96, section: 48, sub: 28, metric: 24 };
const DISPLAY_TAG: Record<DisplaySize, "h1" | "h2" | "h3" | "div"> = {
  hero: "h1",
  section: "h2",
  sub: "h3",
  metric: "div",
};

export interface DisplayProps {
  children: ReactNode;
  size?: DisplaySize;
  color?: string;
  className?: string;
}

export function Display({ children, size = "section", color = "var(--signal)", className }: DisplayProps): React.JSX.Element {
  const Tag = DISPLAY_TAG[size];
  return (
    <Tag
      className={className}
      style={{
        fontFamily: "var(--display)",
        fontWeight: 700,
        textTransform: "uppercase",
        lineHeight: 0.9,
        letterSpacing: "-0.015em",
        fontSize: DISPLAY_PX[size],
        color,
        margin: 0,
      }}
    >
      {children}
    </Tag>
  );
}

// ── Mono — micro-label monospace ───────────────────────────────────────────────────────────
export interface MonoProps {
  children: ReactNode;
  size?: number;
  color?: string;
  className?: string;
}

export function Mono({ children, size = 12, color = "var(--signal-deep)", className }: MonoProps): React.JSX.Element {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: size,
        letterSpacing: "0.08em",
        lineHeight: 1.7,
        color,
      }}
    >
      {children}
    </span>
  );
}

// ── Metric — a count-up value over a mono label, in a 1px-divided strip ─────────────────────
export interface MetricProps {
  label: ReactNode;
  value: number;
  format?: (n: number) => string;
  className?: string;
}

export function Metric({ label, value, format, className }: MetricProps): React.JSX.Element {
  return (
    <div
      className={className}
      style={{ borderTop: "1px solid var(--signal-12)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}
    >
      <span style={{ fontSize: 24 }}>
        <CountUp to={value} {...(format ? { format } : {})} />
      </span>
      <Mono size={10}>{label}</Mono>
    </div>
  );
}

// ── Divider — the 1px --signal-12 rule that does all the hierarchy work ─────────────────────
export interface DividerProps {
  className?: string;
}

export function Divider({ className }: DividerProps): React.JSX.Element {
  return <div role="separator" className={className} style={{ height: 1, background: "var(--signal-12)", border: "none" }} />;
}

// ── Chip — a mono status pill, --signal border, no radius >2px ──────────────────────────────
export interface ChipProps {
  children: ReactNode;
  className?: string;
}

export function Chip({ children, className }: ChipProps): React.JSX.Element {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 10,
        letterSpacing: "0.1em",
        color: "var(--signal-deep)",
        border: "1px solid var(--signal)",
        borderRadius: 2,
        padding: "2px 8px",
        display: "inline-block",
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
}

// ── Button — dark primary, radius ≤4px, generous x-padding ──────────────────────────────────
export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
}

export function Button({ children, onClick, type = "button", className }: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      className={className}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 13,
        letterSpacing: "0.08em",
        background: "var(--ink-dark)",
        color: "var(--field-on-dark)",
        border: "none",
        borderRadius: 4,
        padding: "12px 28px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ── TextLink — red underlined text link with a → ────────────────────────────────────────────
export interface TextLinkProps {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}

export function TextLink({ children, href, onClick, className }: TextLinkProps): React.JSX.Element {
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 13,
        letterSpacing: "0.08em",
        color: "var(--signal-deep)",
        textDecoration: "underline",
      }}
    >
      {children} →
    </a>
  );
}

// ── Input — dark, borderless, mono uppercase, red focus underline + outline (A5) ────────────
export interface InputProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  type?: string;
  name?: string;
  className?: string;
}

export function Input({ value, onChange, placeholder, type = "text", name, className }: InputProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={type}
      name={name}
      value={value}
      placeholder={placeholder}
      className={className}
      onChange={(e) => onChange?.(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        fontFamily: "var(--mono)",
        fontWeight: 400,
        textTransform: "uppercase",
        fontSize: 13,
        letterSpacing: "0.08em",
        background: "var(--ink-dark)",
        color: "var(--field-on-dark)",
        border: "none",
        borderBottom: "1px solid var(--signal)",
        outline: focused ? "2px solid var(--signal)" : "none",
        padding: "8px 4px",
      }}
    />
  );
}

// ── EmptyState — one muted mono line ────────────────────────────────────────────────────────
export interface EmptyStateProps {
  children?: ReactNode;
  className?: string;
}

export function EmptyState({ children = "Nothing here yet", className }: EmptyStateProps): React.JSX.Element {
  return (
    <Mono size={11} {...(className ? { className } : {})}>
      {children}
    </Mono>
  );
}

// ── Loading — "SYNCING" muted mono, no skeleton, no shimmer ─────────────────────────────────
export interface LoadingProps {
  label?: string;
  className?: string;
}

export function Loading({ label = "SYNCING", className }: LoadingProps): React.JSX.Element {
  return (
    <Mono size={11} {...(className ? { className } : {})}>
      {label}
    </Mono>
  );
}

// ── ErrorState — "FAILED" display + one retry button (REQ-115) ──────────────────────────────
export interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message = "FAILED", onRetry, className }: ErrorStateProps): React.JSX.Element {
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
      <Display size="sub">{message}</Display>
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}
