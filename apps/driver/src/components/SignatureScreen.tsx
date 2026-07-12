import { useEffect, useRef, useState } from "react";
import { Display, Mono, TOKENS } from "@shuddl/design";
import { bytesFromDataUrl } from "../lib/capture-bytes.js";
import { ProgressLine } from "./ProgressLine.js";
import { Screen } from "./Screen.js";
import { TapButton } from "./TapButton.js";

// REQ-064 — signature on glass, captured as hashed evidence. A `--field` glass panel sits on the ink
// ground; the driver signs in ink-dark strokes; on ADVANCE the strokes → a PNG data URL → bytes →
// `capture` (SHA-256 at capture) → the pod.signed hash. ADVANCE is dead until the glass holds ink.
export function SignatureScreen({
  header,
  progress,
  question,
  caption,
  onCommit,
}: {
  header: string;
  progress: number;
  question: string;
  caption: string;
  onCommit: (bytes: Uint8Array) => void;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  // Size the canvas backing store to its box so strokes land under the pointer, and paint the ink color.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.strokeStyle = TOKENS.inkDark;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
  }, []);

  function at(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>): void {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawing.current = true;
    const { x, y } = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = at(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  }

  function up(): void {
    drawing.current = false;
  }

  function clear(): void {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }

  function commit(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onCommit(bytesFromDataUrl(canvas.toDataURL("image/png")));
  }

  return (
    <Screen>
      <ProgressLine label={header} progress={progress} />

      <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, marginTop: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Mono size={12} color="var(--signal-55)">
            GATE · REQUIRED
          </Mono>
          <Display size="sub" color="var(--field-on-dark)">
            {question}
          </Display>
        </div>

        {/* The glass — a light --field panel the driver signs on, ink-dark strokes. */}
        <div style={{ position: "relative", flex: 1, background: "var(--field)", borderRadius: 4, overflow: "hidden" }}>
          <canvas
            ref={canvasRef}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerLeave={up}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" }}
          />
          {/* Signature baseline + prompt (behind the ink). */}
          <div style={{ position: "absolute", left: 24, right: 24, bottom: 40, borderBottom: "1px solid var(--signal-deep)" }} />
          <span style={{ position: "absolute", left: 24, bottom: 16, pointerEvents: "none" }}>
            <Mono size={11} color="var(--signal-deep)">
              {hasInk ? "SIGNATURE CAPTURED" : "SIGN ABOVE THE LINE"}
            </Mono>
          </span>
        </div>

        <Mono size={11} color="var(--field-on-dark)">
          {caption}
        </Mono>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <TapButton onClick={commit} disabled={!hasInk}>
          Advance
        </TapButton>
        <button
          type="button"
          onClick={clear}
          style={{
            fontFamily: "var(--mono)",
            fontWeight: 400,
            textTransform: "uppercase",
            fontSize: 12,
            letterSpacing: "0.08em",
            background: "transparent",
            color: "var(--signal-55)",
            border: "none",
            padding: "6px 2px",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          Clear signature
        </button>
      </div>
    </Screen>
  );
}
