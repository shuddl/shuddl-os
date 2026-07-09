// REQ-111 (partial): structured logs are event-shaped from day one.
// The log→ledger pipeline lands with the ledger at WP-02.
export function logEvent(kind: string, payload: Record<string, unknown>, req_id?: string): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind: `log.${kind}`, req_id, payload }));
}
