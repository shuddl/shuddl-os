// §1581 (REQ-035/192) — ONE `isRecord` FOR THIS WORKER.
//
// There were three copies. Two carried `!Array.isArray(v)`; the one in `tools/registry.ts` did not, so
// `isRecord([])` was **true** there and **false** in its siblings — and that copy guards the wire, including
// `toToolResult`, which put any "record" into `structuredContent`. A tool returning an array therefore produced
// `structuredContent: [...]`, which is specified to be an object and is what the REST mirror answers as the
// entire body. Unreachable with today's six tools, all of which return object literals; one handler away
// otherwise.
//
// The copies are gone rather than pinned by a gate, because the divergence existed only because copies did:
// a predicate that three call sites must agree on has one definition.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
