// WP-12 Task 6 · REQ-202 — the malformed-doc QUARANTINE descriptor core. An inbound 204/214/990 that fails to
// parse is NEVER silently dropped (Migrator rule / CLAUDE.md #10): it becomes an `anomalies` row
// (db/tenant/migrations/0002_domain.sql: id, rule, object_kind, object_id, severity, detail) that the WP-11
// exceptions queue surfaces for a human. PURE (REQ-204): a stable synchronous hash — no Date, no random, no
// I/O — so a redelivered malformed doc yields the SAME anomaly id and the worker's INSERT OR IGNORE is a
// no-op (idempotent, the make-agent-idempotent doctrine).

// The quarantine rule (the anomalies.rule column). `edi_malformed` = a doc that failed to PARSE; `edi_no_
// shipment_ref` = a doc that parsed but carries no stable business ref (SID/BOL/PRO/PO) to mint an idempotent
// shipment id, so it cannot become a booking without risking a duplicate; `edi_uncertified_partner` = a doc from
// an authenticated partner whose mapping is NOT replay-certified yet (REQ-203) — HELD for certification, never
// parsed into a booking on an unverified mapping. All three surface on the exceptions queue.
// edi_tenant_policy_unusable (2026-08-02 §19): the tenant control row is missing or its policy is unusable,
// so the sequencer would refuse every append. DETERMINISTIC — quarantine + 200, never a 5xx retry-storm.
export type QuarantineRule = "edi_malformed" | "edi_no_shipment_ref" | "edi_uncertified_partner" | "edi_tenant_policy_unusable";

export interface QuarantineInput {
  partnerId: string;
  isaControl: string;
  docType: string;
  parseError: string;
  r2Key: string;
  /** Defaults to `edi_malformed` (the parse-failure case) when omitted. */
  rule?: QuarantineRule;
}

export interface QuarantineDescriptor {
  anomalyId: string;
  rule: QuarantineRule;
  objectKind: "edi_doc";
  objectId: string;
  severity: "warn";
  detail: Record<string, unknown>;
}

// FNV-1a (64-bit, BigInt) — a small deterministic string hash. Synchronous (unlike crypto.subtle, which is
// async and would force this descriptor to return a Promise) and dependency-free; collision resistance is not
// a security property here, only stable idempotency keying, for which FNV-1a is sufficient.
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export function quarantineDescriptor(input: QuarantineInput): QuarantineDescriptor {
  // The id is keyed ONLY on (partnerId, isaControl): a redelivered malformed doc — even under a different r2
  // key or a differently-worded parse error — collapses to the SAME anomaly row. Domain-separated so it never
  // collides with another id namespace. The `\u0000` separator cannot appear in either field's normal value,
  // so ("ab","c") and ("a","bc") never alias.
  const anomalyId = `edi_quarantine_${fnv1a64(`edi:quarantine:${input.partnerId}\u0000${input.isaControl}`)}`;
  return {
    anomalyId,
    rule: input.rule ?? "edi_malformed",
    objectKind: "edi_doc",
    objectId: `${input.partnerId}:${input.isaControl}`,
    severity: "warn",
    detail: {
      parse_error: input.parseError,
      r2_key: input.r2Key,
      doc_type: input.docType,
      partner_id: input.partnerId,
    },
  };
}
