import { z } from "zod";
import { Role } from "./roles.js";

// REQ-132/156: tenant comes from the JWT claim — never a client-supplied id (doc 14 §04).
export const SessionClaims = z.object({
  sub: z.string(),
  tenant: z.string(),
  role: Role,
  exp: z.number(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;
