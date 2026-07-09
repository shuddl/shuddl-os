import { sign } from "hono/jwt";

export async function token(claims: Record<string, unknown>, secret = "test-secret-do-not-use-in-prod"): Promise<string> {
  return sign({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims }, secret);
}
