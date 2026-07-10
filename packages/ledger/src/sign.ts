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
  if (!e.sig) return false;
  const key = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64u.dec(e.sig) as BufferSource,
    canonicalBytes(clientView(e)) as BufferSource,
  );
}
