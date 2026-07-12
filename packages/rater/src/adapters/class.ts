import type { ClassAdapter } from "@shuddl/contracts";

// REQ-004: freight class is an EDGE adapter (class ↔ density), never the engine foundation. No SMC3/NMFC
// table is baked in here — every mapping comes from the tenant's ClassAdapter config (a version-pinned
// rate_config payload). A class absent from the config is a CONFIG GAP that throws loudly, not a silent
// default. This is the whole adapter for WP-04: a single config-driven lookup. The core pricing engine
// does not consume class (it prices from measured physics); this exists only to translate at the boundary.
export function classToDensityPcf(freightClass: string, adapter: ClassAdapter): number {
  const d = adapter.class_to_density_pcf[freightClass];
  if (d === undefined) throw new Error(`class ${freightClass} not in class_adapter ${adapter.id}@${adapter.version}`);
  return d; // lb/ft³, positive finite (guaranteed by the ClassAdapter schema)
}
