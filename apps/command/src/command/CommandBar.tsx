import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Mono, Reveal } from "@shuddl/design";
import { commands, type Command, type CommandDeps, type CommandOutcome } from "./registry.js";

// WP-10 Task 10 (REQ-081) — the ⌘K command PALETTE UI. A global ⌘K / Ctrl+K opens it; Esc closes it. It is a
// DETERMINISTIC filter over the FIXED registry (no LLM, no NL parse): type to filter by label, Arrow keys move
// focus, Enter runs the focused command. A command that needs args prompts for them one structured field at a
// time (the `Input` primitive — NOT a free-text intent box). A mutation reflects its result HONESTLY (a
// gate-block / 403 / HELD booking shows the real reason, never a fake success).
//
// DESIGN (token-only, BLOCKING at WP-10 exit): every surface is `var(--ink-dark)`; every rule is `var(--signal-12)`;
// text is `Mono`; the focused row tints with `var(--signal-12)` + a `var(--signal)` edge; the entrance is the
// existing `Reveal` primitive. No new color, no shadow, no gradient, no radius >4px, no hand-rolled keyframe.

const isOpenCombo = (e: KeyboardEvent): boolean => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";

export interface CommandBarProps {
  deps: CommandDeps;
}

export function CommandBar({ deps }: CommandBarProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(""); // the current field: the filter query in list mode, the arg value in arg mode
  const [activeIdx, setActiveIdx] = useState(0);
  const [pending, setPending] = useState<Command | null>(null); // non-null ⇒ collecting args for this command
  const [argIdx, setArgIdx] = useState(0);
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The filtered list (list mode only). A simple case-insensitive label substring — deterministic, no ranking magic.
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands.slice();
  }, [text]);

  function reset(): void {
    setText("");
    setActiveIdx(0);
    setPending(null);
    setArgIdx(0);
    setArgValues({});
    setResult(null);
  }
  function close(): void {
    setOpen(false);
    reset();
  }

  async function runCommand(cmd: Command, args: Record<string, string>): Promise<void> {
    const outcome = await Promise.resolve(cmd.run(args, deps));
    // A navigation / lens / intake seam has already happened — close on success. A dispatched mutation stays open
    // to REFLECT its honest result (a success confirmation OR the real server reason). A failed seam also reflects.
    if (outcome.ok && cmd.target.kind !== "post") {
      close();
      return;
    }
    setResult(outcome);
  }

  // Advance the arg wizard: commit the current field as the active arg, then either prompt the next or run.
  function commitArg(cmd: Command): void {
    const arg = cmd.args[argIdx];
    if (!arg) return;
    const next = { ...argValues, [arg.key]: text };
    if (argIdx + 1 < cmd.args.length) {
      setArgValues(next);
      setArgIdx(argIdx + 1);
      setText("");
      return;
    }
    setText("");
    void runCommand(cmd, next);
  }

  function selectFocused(): void {
    const cmd = filtered[activeIdx];
    if (!cmd) return;
    if (cmd.args.length > 0) {
      setPending(cmd);
      setArgIdx(0);
      setArgValues({});
      setText("");
      setResult(null);
      return;
    }
    void runCommand(cmd, {});
  }

  // ONE global keydown handler, kept fresh via a ref so it always sees the latest state without re-subscribing.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e: KeyboardEvent): void => {
    if (isOpenCombo(e)) {
      e.preventDefault();
      if (open) close();
      else {
        reset();
        setOpen(true);
      }
      return;
    }
    if (!open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    // Once a result is shown, Enter dismisses it (Escape already closes above).
    if (result !== null) {
      if (e.key === "Enter") {
        e.preventDefault();
        close();
      }
      return;
    }
    if (pending) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitArg(pending);
      }
      return; // arg mode: Arrow keys are plain text cursor moves, not list navigation
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectFocused();
    }
  };

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => handlerRef.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Keep the highlighted row in range when the filter shrinks the list.
  useEffect(() => {
    if (activeIdx > filtered.length - 1) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  // Focus the field whenever the palette opens or the wizard advances a step, so typing lands immediately.
  useEffect(() => {
    if (open) panelRef.current?.querySelector("input")?.focus();
  }, [open, pending, argIdx, result]);

  const argSpec = pending ? pending.args[argIdx] : undefined;
  const placeholder = argSpec ? argSpec.label : "Type a command";

  return (
    <>
      {/* The overlay palette. */}
      {open ? (
        <div
          role="dialog"
          aria-label="Command palette"
          style={{ position: "fixed", inset: 0, zIndex: 20, display: "flex", justifyContent: "center", alignItems: "flex-start" }}
        >
          {/* Backdrop — the map dims behind, the same world-dim honesty the exception pulse uses. Click to close. */}
          <div
            aria-hidden
            onClick={close}
            style={{ position: "absolute", inset: 0, background: "var(--ink-dark)", opacity: 0.55 }}
          />
          <Reveal>
            <div
              ref={panelRef}
              style={{
                position: "relative",
                marginTop: "12vh",
                width: "min(560px, 92vw)",
                background: "var(--ink-dark)",
                border: "1px solid var(--signal-12)",
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <Mono size={10} color="var(--signal-55)">
                  COMMAND
                </Mono>
                <Mono size={10} color="var(--signal-55)">
                  ⌘K
                </Mono>
              </div>

              {/* The field is meaningless once a result is reflected — hide it then. */}
              {result === null ? <Input value={text} onChange={setText} placeholder={placeholder} /> : null}

              {result !== null ? (
                // Honest result reflection — success in field-on-dark, a gate-block / failure in the alarm token.
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Mono size={11} color={result.ok ? "var(--field-on-dark)" : "var(--signal)"}>
                    {result.message}
                  </Mono>
                  <Mono size={10} color="var(--signal-55)">
                    ENTER OR ESC TO DISMISS
                  </Mono>
                </div>
              ) : pending ? (
                // Arg step — one structured field at a time, with the collected values shown honestly.
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Mono size={10} color="var(--signal-55)">
                    {pending.label} — STEP {argIdx + 1}/{pending.args.length}
                  </Mono>
                  {pending.args.slice(0, argIdx).map((a) => (
                    <div key={a.key} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                      <Mono size={11} color="var(--signal-55)">
                        {a.label}
                      </Mono>
                      <Mono size={11} color="var(--field-on-dark)">
                        {argValues[a.key] ?? ""}
                      </Mono>
                    </div>
                  ))}
                  <Mono size={10} color="var(--signal-55)">
                    ENTER TO CONTINUE · ESC TO CANCEL
                  </Mono>
                </div>
              ) : (
                // The filtered command list.
                <div style={{ display: "flex", flexDirection: "column", maxHeight: "48vh", overflowY: "auto" }}>
                  {filtered.length === 0 ? (
                    <Mono size={11} color="var(--signal-55)">
                      NO MATCHING COMMAND
                    </Mono>
                  ) : (
                    filtered.map((c, i) => (
                      <button
                        key={c.id}
                        type="button"
                        aria-current={i === activeIdx}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => {
                          setActiveIdx(i);
                          selectFocused();
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: 16,
                          textAlign: "left",
                          // The focused row is a --signal-12 tint (the same 1px-divider token doing highlight work) —
                          // no thick border, no new color. An inert row is transparent.
                          background: i === activeIdx ? "var(--signal-12)" : "transparent",
                          borderLeft: i === activeIdx ? "1px solid var(--signal)" : "1px solid transparent",
                          padding: "8px 10px",
                          cursor: "pointer",
                        }}
                      >
                        <Mono size={12} color="var(--field-on-dark)">
                          {c.label}
                        </Mono>
                        <Mono size={10} color="var(--signal-55)">
                          {c.section}
                        </Mono>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </Reveal>
        </div>
      ) : null}

      {/* The bottom command-bar hint — the ⌘K affordance stays (REQ-073/080). Click to open the palette. */}
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        aria-label="Open command palette"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--ink-dark)",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          border: "none",
          borderTop: "1px solid var(--signal-12)",
          width: "100%",
          cursor: "pointer",
        }}
      >
        <Mono size={12} color="var(--field-on-dark)">
          ⌘K
        </Mono>
        <Mono size={12} color="var(--signal-55)">
          Command — quote, dispatch, approve, ask
        </Mono>
        <span aria-hidden style={{ width: 8, height: 15, background: "var(--signal)" }} />
      </button>
    </>
  );
}
