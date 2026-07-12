import { useCallback, useEffect, useRef, useState } from "react";
import { Display, Mono } from "@shuddl/design";
import { bytesFromDataUrl, frameDataUrl } from "../lib/capture-bytes.js";
import { ProgressLine } from "./ProgressLine.js";
import { Screen } from "./Screen.js";
import { TapButton } from "./TapButton.js";

// REQ-063 — the forced photo. A real capture REQUIRES A LIVE CAMERA STREAM: SHUTTER only produces a
// frame when `getUserMedia` succeeded, and ADVANCE (`disabled={!taken}`) stays dead until a real frame
// exists. When the camera is DENIED / has no lens the driver is BLOCKED behind a "CAMERA PERMISSION
// REQUIRED" state with a re-request affordance — NO synthetic frame may satisfy the gate, so a driver
// who denies the camera cannot manufacture content-free photos.
//
// The dark viewfinder the screenshot harness shows is a purely VISUAL stub, gated behind an explicit
// render flag (`?stub=1`, or the `stubViewfinder` prop in tests). It renders the ink-dark viewfinder for
// the screenshot but produces NO capturable frame and leaves ADVANCE disabled.
//
// One event per photo: SHUTTER only sets the LOCAL frame (retake just replaces it), and the single
// ADVANCE commits the final frame through `onCommit`. So a driver retaking a photo never queues a
// redundant freight.photographed/bytes — only the committed frame is captured.

type CamState = "requesting" | "live" | "denied";

/** Whether the visual-only stub viewfinder is requested (render/dev flag — NEVER a capturable frame). */
function stubViewfinderRequested(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("stub") === "1";
  } catch {
    return false;
  }
}

export function CameraScreen({
  header,
  progress,
  question,
  caption,
  onCommit,
  stubViewfinder,
}: {
  header: string;
  progress: number;
  question: string;
  caption: string;
  onCommit: (bytes: Uint8Array) => void;
  /** Force the visual-only stub viewfinder (render harness / tests). Defaults to the `?stub=1` flag. */
  stubViewfinder?: boolean;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [camState, setCamState] = useState<CamState>("requesting");

  const stub = stubViewfinder ?? stubViewfinderRequested();

  // Ask for the rear camera. Reused by mount AND the re-request button on the blocked state. A denial
  // (or no lens) lands on `denied` — the BLOCKED state — never a stub-frame fallback.
  const requestCamera = useCallback(async (): Promise<void> => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      setLive(false);
      setCamState("denied");
      return;
    }
    setCamState("requesting");
    try {
      const s = await md.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = s;
      setLive(true);
      setCamState("live");
    } catch {
      setLive(false);
      setCamState("denied"); // permission denied / no lens → the driver is BLOCKED (no synthetic frame)
    }
  }, []);

  useEffect(() => {
    void requestCamera();
    return () => {
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
      streamRef.current = null;
    };
  }, [requestCamera]);

  // Attach the live stream once the <video> is mounted (also handles the re-request → viewfinder race).
  useEffect(() => {
    const v = videoRef.current;
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play?.().catch(() => undefined);
    }
  }, [camState]);

  // SHUTTER captures the LOCAL frame only (retake replaces it). A capture REQUIRES a live camera — with
  // no live stream `frameDataUrl` returns null and nothing is taken, so ADVANCE stays disabled (REQ-063).
  function shutter(): void {
    if (!live) return;
    const url = frameDataUrl(videoRef.current);
    if (url) setTaken(url);
  }

  // ADVANCE commits the final frame: hash-at-capture via `capture` + enqueue happen once, here.
  function advance(): void {
    if (taken) onCommit(bytesFromDataUrl(taken));
  }

  // BLOCKED — camera denied/unavailable and NOT a stub render: the forced photo cannot be satisfied.
  if (camState === "denied" && !stub) {
    return (
      <Screen>
        <ProgressLine label={header} progress={progress} />

        <div style={{ display: "flex", flexDirection: "column", gap: 16, textAlign: "center", padding: "0 8px" }}>
          <Mono size={12} color="var(--signal)">
            CAMERA PERMISSION REQUIRED
          </Mono>
          <Display size="sub" color="var(--field-on-dark)">
            {question}
          </Display>
          <Mono size={11} color="var(--signal-55)">
            THE FORCED PHOTO CANNOT BE SKIPPED — ENABLE THE CAMERA TO CONTINUE
          </Mono>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <TapButton onClick={() => void requestCamera()}>Enable camera</TapButton>
          <TapButton onClick={advance} disabled>
            Advance
          </TapButton>
          <Mono size={11} color="var(--signal-55)">
            A PHOTO IS REQUIRED — CANNOT SKIP
          </Mono>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <ProgressLine label={header} progress={progress} />

      {/* Viewfinder — always dark. Corner reticle + the framing instruction; a captured frame replaces it. */}
      <div
        style={{
          position: "relative",
          flex: 1,
          margin: "22px 0",
          border: "1px solid var(--signal-12)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 16,
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: live && !taken ? 1 : 0,
          }}
        />
        {taken ? (
          <img src={taken} alt="captured freight" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
        <Corner top left />
        <Corner top right />
        <Corner bottom left />
        <Corner bottom right />
        <div style={{ position: "relative", padding: 24, textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
          <Mono size={12} color="var(--signal)">
            {taken ? "FRAME CAPTURED" : live ? "CAMERA · LIVE" : "CAMERA · DARK"}
          </Mono>
          <Display size="sub" color="var(--field-on-dark)">
            {question}
          </Display>
          <Mono size={11} color="var(--signal-55)">
            {caption}
          </Mono>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <button
          type="button"
          onClick={shutter}
          style={{
            fontFamily: "var(--mono)",
            fontWeight: 400,
            textTransform: "uppercase",
            fontSize: 15,
            letterSpacing: "0.12em",
            background: "var(--signal)",
            color: "var(--field)",
            border: "none",
            borderRadius: 4,
            padding: "26px 24px",
            width: "100%",
            cursor: "pointer",
          }}
        >
          {taken ? "Retake" : "Shutter"}
        </button>
        <TapButton onClick={advance} disabled={!taken}>
          Advance
        </TapButton>
        <Mono size={11} color="var(--signal-55)">
          {taken ? "HASHED · QUEUED OFFLINE" : "A PHOTO IS REQUIRED — CANNOT SKIP"}
        </Mono>
      </div>
    </Screen>
  );
}

// A 1px reticle corner in transparent coral — the framing guide, no fill, no shadow.
function Corner({ top, bottom, left, right }: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean }): React.JSX.Element {
  const style: React.CSSProperties = {
    position: "absolute",
    width: 22,
    height: 22,
    ...(top ? { top: 12, borderTop: "1px solid var(--signal-55)" } : {}),
    ...(bottom ? { bottom: 12, borderBottom: "1px solid var(--signal-55)" } : {}),
    ...(left ? { left: 12, borderLeft: "1px solid var(--signal-55)" } : {}),
    ...(right ? { right: 12, borderRight: "1px solid var(--signal-55)" } : {}),
  };
  return <div style={style} />;
}
