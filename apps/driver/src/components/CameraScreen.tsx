import { useEffect, useRef, useState } from "react";
import { Display, Mono } from "@shuddl/design";
import { bytesFromDataUrl, frameDataUrl } from "../lib/capture-bytes.js";
import { ProgressLine } from "./ProgressLine.js";
import { Screen } from "./Screen.js";
import { TapButton } from "./TapButton.js";

// REQ-063 — the forced photo. The camera UI is ALWAYS-DARK (the ink ground IS the viewfinder). The
// photo path is UNTYPASSABLE: ADVANCE stays dead until a frame is captured. Real camera bytes come
// from `getUserMedia`; when there's no lens (a headless render, a denied permission) it degrades to a
// deterministic stub frame — the capture path (hash-at-capture via `capture`) runs either way.
//
// One event per photo: SHUTTER only sets the LOCAL frame (retake just replaces it), and the single
// ADVANCE commits the final frame through `onCommit`. So a driver retaking a photo never queues a
// redundant freight.photographed/bytes — only the committed frame is captured.
export function CameraScreen({
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      md.getUserMedia({ video: { facingMode: "environment" } })
        .then((s) => {
          stream = s;
          if (videoRef.current) {
            videoRef.current.srcObject = s;
            void videoRef.current.play().catch(() => undefined);
            setLive(true);
          }
        })
        .catch(() => setLive(false)); // no lens / denied → the stub-frame path renders
    }
    return () => {
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, []);

  // SHUTTER captures the LOCAL frame only (retake replaces it) — nothing is queued until ADVANCE.
  function shutter(): void {
    setTaken(frameDataUrl(videoRef.current));
  }

  // ADVANCE commits the final frame: hash-at-capture via `capture` + enqueue happen once, here.
  function advance(): void {
    if (taken) onCommit(bytesFromDataUrl(taken));
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
            {taken ? "FRAME CAPTURED" : live ? "CAMERA · LIVE" : "CAMERA · DARK — STUB FRAME"}
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
