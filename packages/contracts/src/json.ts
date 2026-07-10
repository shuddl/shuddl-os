import { z } from "zod";

// REQ-011 / REQ-002: the integer-only canonical law at the Zod boundary. Numbers in
// the ledger are ALWAYS integers (money = signed cents, geo = microdegrees, confidence
// = basis points, time = epoch ms). Floats, -0, and unsafe integers are rejected here
// AND again in packages/ledger canonical.ts (the byte law). z.number().int() in Zod 4
// already rejects unsafe integers; the refine adds -0 rejection and stays chainable
// (.min/.max/.brand still apply on top).
export const SafeInt = z
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n) && !Object.is(n, -0), "integer-only canonical law");

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// Loosely-typed payloads (30 of the 35 kinds) validate against this recursive schema so
// that every number in a stored payload is an integer — no float can enter the chain.
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), SafeInt, z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

export const JsonObject = z.record(z.string(), JsonValue);
export type JsonObject = z.infer<typeof JsonObject>;
