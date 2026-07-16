import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionClaims } from "@shuddl/contracts";
import { adoptTokenFromUrl, clear, getClaims, getToken, isAuthed, setToken } from "./session.js";

// A base64url encoder + an UNSIGNED test JWT (header.payload.sig). The client NEVER verifies the
// signature (no secret on the client), so "sig" is a placeholder — getClaims only reads the payload.
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

// All synthetic placeholders (REQ-167) — never a real tenant/party.
const CLAIMS: SessionClaims = {
  sub: "u:portal-1",
  tenant: "t:synthetic",
  role: "portal",
  party_id: "party-0",
  exp: Math.floor(Date.now() / 1000) + 3600,
};

describe("portal session (REQ-085)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("adopts a ?token= from the URL, persists it, and STRIPS it from the URL", () => {
    const jwt = makeJwt(CLAIMS);
    window.history.replaceState(null, "", `/portal?token=${jwt}&x=1`);

    const adopted = adoptTokenFromUrl();

    expect(adopted).toBe(jwt);
    expect(getToken()).toBe(jwt); // persisted for later loads
    expect(window.location.search).not.toContain("token"); // never lingers in history / shared links
    expect(window.location.search).toContain("x=1"); // unrelated params survive
  });

  it("adoptTokenFromUrl is a no-op (returns null) when there is no ?token=", () => {
    window.history.replaceState(null, "", "/portal");
    expect(adoptTokenFromUrl()).toBeNull();
    expect(getToken()).toBeNull();
  });

  it("getClaims decodes the JWT payload WITHOUT verifying (UI scoping only)", () => {
    setToken(makeJwt(CLAIMS));
    expect(getClaims()).toEqual(CLAIMS);
  });

  it("getClaims returns null for a malformed / non-JWT token", () => {
    setToken("not-a-jwt");
    expect(getClaims()).toBeNull();
  });

  it("getClaims returns null when the payload is not valid SessionClaims", () => {
    setToken(makeJwt({ hello: "world" }));
    expect(getClaims()).toBeNull();
  });

  it("isAuthed is true for an unexpired token and false once expired", () => {
    setToken(makeJwt({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 3600 }));
    expect(isAuthed()).toBe(true);

    setToken(makeJwt({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(isAuthed()).toBe(false);
  });

  it("isAuthed is false with no session (public pages run token-less)", () => {
    clear();
    expect(isAuthed()).toBe(false);
    expect(getToken()).toBeNull();
  });

  it("clear() wipes the token + claims (logout / on 401)", () => {
    setToken(makeJwt(CLAIMS));
    expect(getToken()).not.toBeNull();

    clear();

    expect(getToken()).toBeNull();
    expect(getClaims()).toBeNull();
    expect(isAuthed()).toBe(false);
  });
});
