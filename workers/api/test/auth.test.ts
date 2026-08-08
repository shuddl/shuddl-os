import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ErrorEnvelope } from "@shuddl/contracts";
import { token } from "./helpers.js";
import { env } from "cloudflare:test";
import { mintDocDownloadCap } from "../src/pub/doc-cap.js";
import { mintStatusCap } from "../src/pub/status-cap.js";

describe("REQ-132/133: authn", () => {
  it("rejects missing token", async () => {
    const res = await SELF.fetch("https://api.local/v1/whoami");
    expect(res.status).toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });
  it("rejects a token signed with the wrong secret", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" }, "attacker-secret");
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  it("rejects claims that fail the schema (unknown role)", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "superuser" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });
  // REQ-085/132 §661 — THE REVERSE PAIRS: a CAP presented as a session Bearer token.
  //
  // §660 closed cap ↔ cap and noted the remaining four ordered pairs rested on "an argument, not an
  // assertion". Two of them are the reverse direction of pairs already tested: session → doc and
  // session → status are asserted (documents.test.ts, status-cap.test.ts), but nothing ever presented a cap
  // AS a session. The argument is that a cap is MAC'd under a derived secret and dies at hono/jwt's
  // verification — true, and it is one layer of two. The second is that SessionClaims requires `sub` and
  // `role`, which no cap carries, so even a shared-secret bug would not mint a session from a cap.
  //
  // Asserted here rather than argued, because these are the two pairs where a failure would turn an
  // UNAUTHENTICATED cap into an AUTHENTICATED session — the only direction in the matrix that escalates
  // across the auth boundary rather than within it.
  it("a DOC CAP is not a session token — an unauthenticated cap never mints a session", async () => {
    const cap = await mintDocDownloadCap(env.JWT_SECRET, { t: "tenant-a", k: "evidence/tenant-a/shp/x", expSeconds: Math.floor(Date.now() / 1000) + 600 });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${cap}` } });
    expect(res.status).toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("a STATUS CAP is not a session token either — the refusal covers both cap types", async () => {
    const cap = await mintStatusCap(env.JWT_SECRET, { t: "tenant-a", s: "shp-1", expSeconds: Math.floor(Date.now() / 1000) + 600 });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${cap}` } });
    expect(res.status).toBe(401);
  });

  it("returns the session for a valid token", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops" });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sub: string; tenant: string; role: string };
    expect(body).toMatchObject({ sub: "u1", tenant: "tenant-a", role: "ops" });
  });
});

describe("REQ-132: role matrix", () => {
  it.each(["driver", "portal", "read"])("role %s cannot hit an ops-gated route", async (role) => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role });
    const res = await SELF.fetch("https://api.local/v1/_probe", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(403);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("FORBIDDEN");
  });
});

// REQ-132/133 §595 — A SESSION TOKEN EXPIRES, AND THERE IS NO SUCH THING AS ONE THAT DOES NOT.
//
// The four cases above cover a missing token, a wrong secret, and bad claims — every way a token can be
// INVALID. None covers a token that was perfectly valid and is now OLD, which is the only failure mode that
// arrives on its own, without an attacker and without a code change.
//
// Expiry is enforced by `hono/jwt`'s `verify` inside `middleware/auth.ts`'s try/catch. Measured, not assumed:
// signing `{ exp: now - 60 }` and verifying it throws `JwtTokenExpired`, while `{ exp: now + 600 }` is
// accepted. So the behaviour is correct — and it rests entirely on a library call wrapped in a `catch` that
// maps EVERY throw to one 401. Swap `verify` for a hand-rolled decode (a plausible refactor: drop a
// dependency, or add custom claim handling) and expiry silently stops being enforced, with every already-
// issued token becoming permanent. Nothing would fail.
//
// The second case is the stronger property. `SessionClaims` makes `exp` REQUIRED, so a token minted without
// one is refused by the schema rather than treated as never-expiring — the fail-closed direction, and the
// reason a missing `exp` cannot become an immortal session.
describe("REQ-132 §595: session expiry", () => {
  const nowSec = (): number => Math.floor(Date.now() / 1000);

  it("rejects a token that was valid and has EXPIRED", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops", exp: nowSec() - 60 });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status, "an expired session was accepted — tokens never stop working").toBe(401);
    expect(ErrorEnvelope.parse(await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("rejects a token carrying NO exp at all — a session cannot be minted immortal", async () => {
    // `token()` defaults an exp, so it is overridden to undefined and stripped, mimicking a mint path that
    // simply forgot to set one.
    const raw = await token({ sub: "u1", tenant: "tenant-a", role: "ops", exp: undefined });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${raw}` } });
    expect(res.status, "a token with no expiry was accepted — that session never ends").toBe(401);
  });

  it("still accepts a token whose exp is in the future (the rule is expiry, not a blanket refusal)", async () => {
    const t = await token({ sub: "u1", tenant: "tenant-a", role: "ops", exp: nowSec() + 600 });
    const res = await SELF.fetch("https://api.local/v1/whoami", { headers: { Authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
  });
});
