import { Mono } from "@shuddl/design";

// The ONE sanctioned teal moment (REQ-078): a `--progress` fill over a `--signal-12` track, marking
// how far through the stop the driver is. Teal is progress ONLY — never text, never state.
export function ProgressLine({ label, progress }: { label: string; progress: number }): React.JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Mono size={11} color="var(--signal-55)">
        {label}
      </Mono>
      <div style={{ height: 4, background: "var(--signal-12)", width: "100%" }}>
        <div style={{ height: 4, background: "var(--progress)", width: `${pct}%` }} />
      </div>
    </div>
  );
}
