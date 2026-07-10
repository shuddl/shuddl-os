import { z } from "zod";
import { Role } from "./roles.js";

// REQ-132/156: tenant comes from the JWT claim — never a client-supplied id (doc 14 §04).
// party_id is likewise claim-only: it scopes a portal session to one party's lens (REQ-015),
// so it must be a signed JWT claim, never a query param or header a caller could forge.
export const SessionClaims = z.object({
  sub: z.string(),
  tenant: z.string(),
  role: Role,
  party_id: z.string().optional(),
  exp: z.number(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;
