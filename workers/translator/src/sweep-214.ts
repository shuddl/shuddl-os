// WP-12 Task 7 · REQ-200 / REQ-025 — THE OUTBOUND 214 STATUS SWEEP. For every EDI-tendered shipment, project
// its SHUDDL status arc into a byte-stable X12 214 (through the pure Task-6 core + @shuddl/edi build214) and
// transmit it via the injected transport port, EXACTLY ONCE. Mirrors the Biller's discipline: deterministic
// dedupe key, append/send-then-mark, per-item fault isolation, "already done" ⇒ skip.
//
// PARTNER↔SHIPMENT LINKAGE — the R2 MARKER CONTRACT (defined HERE; Task 8's 204 handler WRITES the tender):
//   · tender marker  R2 key  edi/<tenant>/tender/<shipmentId>
//                    body    { partnerId, partnerScac, isaControl }  (JSON)
//        This sweep READS these to learn which shipments are EDI-tendered and by whom. gsControl is DERIVED
//        deterministically from isaControl (leading zeros stripped) so the wire stays byte-stable without a
//        second stored field — the marker carries only what the 204 knew.
//   · "214 sent"     R2 key  edi/<tenant>/214/<dedupeKey>          (dedupeKey = edi214/<newest-status id>)
//                    body    the serialized 214 wire bytes
//        The bytes ARE the sent-record — no new table (budget-safe). Its PRESENCE means "already transmitted",
//        so a re-run is a no-op. It is written ONLY after a successful transmit, so an unwired/failed send
//        never leaves a phantom sent-marker and the next tick re-attempts.
//
// REQ-025 isolation: one tenant's D1 + its `edi/<tenant>/…` R2 key scope per iteration; the sweep never reads
// or writes another tenant's namespace. LLM-free and deterministic (no Date, no random) — the whole 214 is a
// pure function of the recorded events + the tender marker.
import { z } from "@shuddl/contracts";
import type { EventKind } from "@shuddl/contracts";
import { readEvents } from "@shuddl/ledger/lens";
import { build214, resolveMapping, DEFAULT_004010, type PartnerMapping } from "@shuddl/edi";
import { buildStatusView, type StatusEventRow } from "./core/build-214.js";
import type { EdiTransport } from "./transport.js";
import { TENANT_SLUGS, tenantDb, type TranslatorEnv } from "./tenants.js";

// The SHUDDL status kinds a 214 projects (the same set the core's STATUS_KIND_TO_TOKEN maps). Kind-filter the
// ledger read to these so the sweep touches only status rows. `custody.transferred` is deliberately excluded —
// the baseline 004010 dialect defines no AT7 code for it (see core/build-214.ts).
const STATUS_KINDS = ["stop.arrived", "stop.departed", "pod.signed", "delivery.evidenced"] as const satisfies readonly EventKind[];

// ---- the R2 marker key contract (single source of truth; the test asserts against these) ----------------
export function tenderPrefix(tenant: string): string {
  return `edi/${tenant}/tender/`;
}
export function tenderKey(tenant: string, shipmentId: string): string {
  return `${tenderPrefix(tenant)}${shipmentId}`;
}
export function sent214Key(tenant: string, dedupeKey: string): string {
  return `edi/${tenant}/214/${dedupeKey}`;
}

// GS06 (group control) derived from ISA13 (interchange control): leading zeros stripped, matching the Task-6
// test convention ("000000042" → "42"). Deterministic ⇒ byte-stable. An all-zero/empty ISA falls back to the
// ISA verbatim (never an empty control number on the wire).
export function gsControlFromIsa(isaControl: string): string {
  const stripped = isaControl.replace(/^0+/, "");
  return stripped === "" ? isaControl : stripped;
}

// The tender marker body — Zod at the boundary (`.strict()`: an unknown field is a hard reject, never a
// silent pass-through). Task 8 writes this; this sweep reads it, so validating here catches a malformed marker
// as a per-shipment skip rather than a thrown sweep.
const TenderMarker = z
  .object({
    partnerId: z.string().min(1),
    partnerScac: z.string().min(1),
    isaControl: z.string().min(1),
  })
  .strict();
type TenderMarker = z.infer<typeof TenderMarker>;

export interface Tenant214Summary {
  tenant: string;
  scanned: number;
  transmitted: number;
  alreadySent: number;
  uncertified: number;
  noPartner: number;
  noStatus: number;
  malformed: number;
  failed: number;
}

// List every tender marker under this tenant's prefix, following the R2 cursor to completion (≤1000/page).
async function listTenderMarkers(r2: R2Bucket, tenant: string): Promise<{ key: string; shipmentId: string }[]> {
  const prefix = tenderPrefix(tenant);
  const out: { key: string; shipmentId: string }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await r2.list(cursor !== undefined ? { prefix, cursor } : { prefix });
    for (const obj of page.objects) {
      const shipmentId = obj.key.slice(prefix.length);
      if (shipmentId !== "") out.push({ key: obj.key, shipmentId });
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return out;
}

async function readTenderMarker(r2: R2Bucket, key: string): Promise<TenderMarker | null> {
  const obj = await r2.get(key);
  if (obj === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    return null;
  }
  const res = TenderMarker.safeParse(parsed);
  return res.success ? res.data : null;
}

// Resolve the partner's stored mapping. An empty/`{}` config yields exactly DEFAULT_004010; a malformed config
// (unknown fields → resolveMapping throws) falls back to DEFAULT_004010 rather than fault the whole shipment
// (Task 9 hardens partner-config validation at certification time).
function mappingFor(config: string): PartnerMapping {
  try {
    return resolveMapping(JSON.parse(config));
  } catch {
    return DEFAULT_004010;
  }
}

// Sweep ONE tenant. Isolated per shipment (log + continue) so one partner's outage never stalls the tenant's
// tick; isolated per tenant by the caller. Never appends an event (reads only) — the 214 lives in R2.
export async function sweepTenant214(
  db: D1Database,
  r2: R2Bucket,
  tenant: string,
  transport: EdiTransport,
): Promise<Tenant214Summary> {
  const summary: Tenant214Summary = {
    tenant, scanned: 0, transmitted: 0, alreadySent: 0, uncertified: 0, noPartner: 0, noStatus: 0, malformed: 0, failed: 0,
  };
  const markers = await listTenderMarkers(r2, tenant);
  for (const { key, shipmentId } of markers) {
    summary.scanned += 1;
    try {
      const tender = await readTenderMarker(r2, key);
      if (tender === null) {
        summary.malformed += 1;
        console.error(`214-sweep: tenant ${tenant} shipment ${shipmentId} — tender marker ${key} missing/malformed, skipping`);
        continue;
      }

      // Only a CERTIFIED partner's outbound is unblocked (REQ-203; Task 9 hardens this). An uncertified or
      // unknown partner is skipped — nothing is built or transmitted.
      const partner = await db
        .prepare("SELECT config, cert_status FROM integrations WHERE kind = 'edi_partner' AND id = ? LIMIT 1")
        .bind(tender.partnerId)
        .first<{ config: string; cert_status: string | null }>();
      if (partner === null) {
        summary.noPartner += 1;
        continue;
      }
      if (partner.cert_status !== "certified") {
        summary.uncertified += 1;
        continue;
      }

      // Project the shipment's status arc (kind-filtered read, tenant lens — the unredacted server truth).
      const events = await readEvents(db, { scope: "tenant" }, { shipment_id: shipmentId, kind: STATUS_KINDS });
      const rows: StatusEventRow[] = events.map((e) => ({ id: e.id, kind: e.kind, ts: e.ts, payload: e.payload }));
      if (rows.length === 0) {
        summary.noStatus += 1;
        continue;
      }

      const { view, dedupeKey } = buildStatusView({
        shipmentRef: shipmentId,
        partnerScac: tender.partnerScac,
        isaControl: tender.isaControl,
        gsControl: gsControlFromIsa(tender.isaControl),
        mapping: mappingFor(partner.config),
        events: rows,
      });

      // Idempotency: the sent-marker's PRESENCE means this exact newest-status 214 already went out.
      const sentKey = sent214Key(tenant, dedupeKey);
      if ((await r2.head(sentKey)) !== null) {
        summary.alreadySent += 1;
        continue;
      }

      const bytes = build214(view);
      // Transmit FIRST; mark sent ONLY on success — a failed/unwired transmit leaves no marker, so the next
      // tick re-attempts (the transport dedupes on the same idempotency key if it did land).
      await transport.send214(tender.partnerScac, bytes, dedupeKey);
      await r2.put(sentKey, bytes);
      summary.transmitted += 1;
    } catch (err) {
      // Biller-style isolation: never throw the whole sweep on one shipment. Log + continue; next tick retries.
      summary.failed += 1;
      console.error(`214-sweep: tenant ${tenant} shipment ${shipmentId} — transmit failed (retry next tick):`, err);
    }
  }
  return summary;
}

// The driven entrypoint — sweep every allowlisted tenant (REQ-025: one tenant's D1 + R2 scope per iteration).
// The transport is INJECTED (selected at the worker composition root, or a recording fake in tests). A per-
// tenant fault is contained + logged so one tenant never stalls the rest; the whole sweep is idempotent, so
// re-running every cron tick is safe.
export async function run214Sweep(env: TranslatorEnv, transport: EdiTransport): Promise<void> {
  for (const slug of TENANT_SLUGS) {
    try {
      const summary = await sweepTenant214(tenantDb(env, slug), env.EVIDENCE, slug, transport);
      console.log(`214-sweep: tenant ${slug} → ${JSON.stringify(summary)}`);
    } catch (err) {
      console.error(`214-sweep: tenant ${slug} failed (re-run next tick — the sweep is idempotent):`, err);
    }
  }
}
