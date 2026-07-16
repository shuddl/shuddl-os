// REQ-085/051 — money on the portal is ALWAYS formatted from INTEGER cents, never float math. The wire
// carries `*_cents` integers (the canonical integer-cents law, doc 10); this turns one into a display
// string ("$1,480.00") using ONLY integer arithmetic — `Math.floor`/`%` on the integer cents, grouping the
// dollar part with a locale grouper (which operates on the exact integer), then the two-digit remainder.
// The value is never divided as a float, so a cent is never lost to binary rounding.

/** Format integer cents as a US-dollar string with thousands separators and a two-digit cent remainder.
 * Integer-only: dollars and the cent remainder are split with `Math.floor`/`%` on the exact integer, so no
 * float division ever touches the money. A negative (a credit/reversal line) keeps its sign. */
export function formatCents(cents: number): string {
  const whole = Math.trunc(cents); // defensive: the wire is integer cents; never carry a fraction through
  const negative = whole < 0;
  const abs = Math.abs(whole);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const grouped = dollars.toLocaleString("en-US"); // groups the exact integer dollar count, no float
  return `${negative ? "-" : ""}$${grouped}.${String(remainder).padStart(2, "0")}`;
}
