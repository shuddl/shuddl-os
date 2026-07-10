import { z } from "zod";
import { SafeInt } from "./json.js";

// REQ-014 — the daily Merkle -> TSA anchor read surface (doc 14 §04). A party verifying its own POD
// hash against a third-party timestamp is the point; the portal lens sees only {day, root} so no
// activity-volume signal leaks across the tenant boundary (Decision 14).

export const AnchorDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD (UTC)");
export type AnchorDay = z.infer<typeof AnchorDay>;

// A Merkle leaf, lower-case hex: an event hash (32 bytes) OR a position's canonical row bytes
// (variable length). Even-length hex only.
export const LeafHex = z.string().regex(/^([0-9a-f]{2})+$/, "leaf must be even-length lower-case hex");
export type LeafHex = z.infer<typeof LeafHex>;

const RootHex = z.string().regex(/^[0-9a-f]{64}$/);

export const ProofStep = z.object({ side: z.enum(["L", "R"]), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ProofStep = z.infer<typeof ProofStep>;

// Full manifest — tenant-lens roles only (carries event/position counts).
export const AnchorManifestResponse = z
  .object({
    version: z.string(),
    tenant: z.string(),
    day: AnchorDay,
    root: RootHex,
    leaf_count: SafeInt.min(0),
    event_count: SafeInt.min(0),
    position_count: SafeInt.min(0),
    imprint: RootHex,
    imprint_message: z.string(),
    receipt_key: z.string(),
    created_at: z.string(),
  })
  .strict();
export type AnchorManifestResponse = z.infer<typeof AnchorManifestResponse>;

// Portal-lens view — root only, no volume signal (Decision 14).
export const AnchorSummaryResponse = z.object({ day: AnchorDay, root: RootHex }).strict();
export type AnchorSummaryResponse = z.infer<typeof AnchorSummaryResponse>;

export const AnchorProofResponse = z
  .object({
    day: AnchorDay,
    root: RootHex,
    proof: z.array(ProofStep),
    receipt_doc_id: z.string(),
  })
  .strict();
export type AnchorProofResponse = z.infer<typeof AnchorProofResponse>;

export const AnchorRunResponse = z
  .object({
    anchored: z.array(AnchorDay),
    skipped: z.array(AnchorDay),
    failed: z.array(AnchorDay),
  })
  .strict();
export type AnchorRunResponse = z.infer<typeof AnchorRunResponse>;
