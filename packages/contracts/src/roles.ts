import { z } from "zod";

// REQ-132 / doc 10 §02 users.role
export const Role = z.enum(["admin", "ops", "finance", "read", "driver", "portal"]);
export type Role = z.infer<typeof Role>;
