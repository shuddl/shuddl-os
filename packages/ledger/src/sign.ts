import { canonicalBytes } from "./canonical.js";
import type { LedgerEvent } from "@shuddl/contracts";

// clientView: exactly the fields a device knows OFFLINE — no seq, no prev_hash, no
// recorded_at (all server-assigned). This is the signed byte set. Frozen forever, like
// the canonical law.
export function clientView(
  e: Pick<LedgerEvent, "id" | "shipment_id" | "kind" | "payload" | "evidence" | "actor" | "ts"> & {
    device_id?: string | undefined;
    device_seq?: number | undefined;
    captured_ts?: number | undefined;
  },
) {
  const { id, shipment_id, kind, payload, evidence, actor, ts, device_id, device_seq, captured_ts } = e;
  return { id, shipment_id, kind, payload, evidence, actor, ts, device_id, device_seq, captured_ts };
}

const b64u = {
  enc: (b: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  dec: (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
};

export async function signEvent(e: Parameters<typeof clientView>[0], key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonicalBytes(clientView(e)) as BufferSource);
  return b64u.enc(sig);
}

export async function verifyEventSig(
  e: Parameters<typeof clientView>[0] & { sig?: string | undefined },
  pubJwk: JsonWebKey,
): Promise<boolean> {
  // The sequencer DO feeds device-/portal-controlled `sig` bytes here (REQ-133). A forged
  // or garbage signature must be a clean `false` (→ 401), never an uncaught throw (→ 500):
  // `b64u.dec` (atob) throws on non-base64url input, and WebCrypto verify throws on a
  // wrong-length signature. Reject the charset up front, then swallow any decode/verify
  // fault as a failed verification. `return await` so a rejected promise lands in `catch`.
  if (!e.sig || !/^[A-Za-z0-9_-]+$/.test(e.sig)) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64u.dec(e.sig) as BufferSource,
      canonicalBytes(clientView(e)) as BufferSource,
    );
  } catch {
    return false;
  }
}
