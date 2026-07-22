import { z } from "zod";
import { Role } from "./roles.js";

// REQ-132/156: tenant comes from the JWT claim — never a client-supplied id (doc 14 §04).
// party_id is likewise claim-only: it scopes a portal session to one party's lens (REQ-015),
// so it must be a signed JWT claim, never a query param or header a caller could forge.
export const SessionClaims = z.object({
  // The authenticated principal id. .min(1) so it is never EMPTY: a valid token always carries a sub, and it is
  // recorded permanently as the co-sign actor on server-emitted control events (WP-15 authority.flipped
  // actor.user) — an empty co-sign would be an unattributable audit record.
  sub: z.string().min(1),
  tenant: z.string(),
  role: Role,
  party_id: z.string().optional(),
  exp: z.number(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;
