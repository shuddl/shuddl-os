// REQ-013 / REQ-016: a driver device mints its OWN P-256 signing key. The private key never leaves
// the device; custody + capture events are co-signed with it (I4), and the sequencer verifies those
// signatures against the exported public JWK (registered server-side at pairing). This module ONLY
// mints the key — persisting the keypair across app launches is the PWA's job (Task 8). Pure: no DOM,
// no IndexedDB, no network.
import { sha256Hex } from "@shuddl/ledger/canonical";

export interface DeviceKey {
  /** Stable id derived from the public key (see `deviceIdFromPublicKey`). */
  device_id: string;
  /** The full P-256 keypair. `privateKey` is extractable so the PWA can persist it; it stays on-device. */
  keyPair: CryptoKeyPair;
  /** The public half, exported for server registration — the sequencer verifies device sigs against this. */
  publicJwk: JsonWebKey;
}

/**
 * Mint a fresh P-256 (ECDSA) device signing key. Non-deterministic by construction (a keypair is
 * random), but the `device_id` is a deterministic function of the public key, so the server can
 * recompute and pin it.
 */
export async function generateDeviceKey(): Promise<DeviceKey> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable: the PWA must be able to persist the private key across sessions
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const device_id = await deviceIdFromPublicKey(keyPair.publicKey);
  return { device_id, keyPair, publicJwk };
}

/**
 * `device_id` = `dev_` + hex SHA-256 of the SPKI-encoded public key. Deterministic in the key (the
 * same public key always yields the same id), collision-resistant, and independent of key ordering
 * so the server can recompute it from the registered public key.
 */
async function deviceIdFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return `dev_${await sha256Hex(new Uint8Array(spki))}`;
}
