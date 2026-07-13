import { Display, Divider, Mono, TextLink } from "@shuddl/design";

// THE EVIDENCE EMAIL VIEW (doc 07 §03; REQ-087) — the brand's furthest-traveling artifact,
// given design-system treatment equal to the app: greige ground, Display "DELIVERED", the
// signature + placed-freight photos FULL-BLEED, unrounded, unfiltered (A6 — the only imagery
// in the product), mono metadata over red rules, the REQ-129 referral surface, the dispute
// footer. Money-as-a-projection-of-physics: POD → invoice + evidence, the same second.
//
// ONE SHARED VIEW, two consumers: the portal renders it as-is (var(--token) references, its
// stylesheet dereferences them); the Biller sends it through renderEvidenceEmail (sibling
// module), which inlines every token to its literal. This module deliberately does NOT import
// react-dom/server — the portal pulls it via the `@shuddl/agents/biller/evidence-email-view`
// subpath so the server renderer + biller core never enter the PWA bundle.
//
// EMAIL-SAFE LAYOUT LAW: Outlook's Word engine drops flex/grid/aspect-ratio, so the column is
// plain block flow, side-by-side pairs are <table role="presentation"> cells, and the
// placeholder slot uses an explicit height. Strings are passed normal-case; the primitives'
// inline `text-transform: uppercase` paints them uppercase (A5 — screen readers and unstyled
// mail clients get real words).

export interface EvidenceEmailData {
  shipment_ref: string; //   e.g. "SHP-40206"
  delivered_at: string; //   pre-formatted display string — this module stays Date-free
  signed_by: string; //      e.g. "J. NAVARRO · RECEIVING"
  location: string; //       e.g. "DENVER, CO 80216"
  invoice_ref: string; //    e.g. "INV-40206"
  total_cents: number; //    INTEGER CENTS — formatted by integer/string math only
  photos: { signature_url?: string; placed_url?: string }; // absent ⇒ documentary placeholder slot
  referral_url: string; //   REQ-129 — the caller appends tracking params
}

/** Integer-cents → "$1,480.00". Integer/string arithmetic ONLY — no float division, no toFixed. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`formatCents: total_cents must be an integer, got ${cents}`);
  if (cents < 0) throw new Error(`formatCents: an invoice total is ≥ 0, got ${cents}`);
  const digits = String(cents).padStart(3, "0");
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${digits.slice(-2)}`;
}

/**
 * A full-bleed, unrounded photo slot. With a src: the real POD image (A6 — unfiltered, no
 * radius, caption paired in the same block). Without: the documentary placeholder — a
 * single-cell presentation table so the caption sits bottom-left without flexbox, and an
 * explicit height (≈4:3 at the ~282px cell width) instead of aspect-ratio.
 */
function PhotoSlot({ caption, src }: { caption: string; src?: string | undefined }): React.JSX.Element {
  if (src !== undefined) {
    return (
      <div>
        <img src={src} alt={caption} style={{ width: "100%", display: "block" }} />
        <div style={{ paddingTop: 6 }}>
          <Mono size={10} color="var(--signal-55)">
            {caption}
          </Mono>
        </div>
      </div>
    );
  }
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        <tr>
          <td
            style={{
              height: 212,
              verticalAlign: "bottom",
              padding: 12,
              background: "var(--signal-07)",
              borderTop: "1px solid var(--signal)",
            }}
          >
            <Mono size={10} color="var(--signal-55)">
              {caption}
            </Mono>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function EvidenceEmailView({ data }: { data: EvidenceEmailData }): React.JSX.Element {
  const meta: ReadonlyArray<[string, string]> = [
    ["Shipment", data.shipment_ref],
    ["Delivered", data.delivered_at],
    ["Signed by", data.signed_by],
    ["Location", data.location],
    ["Invoice", `${data.invoice_ref} · ${formatCents(data.total_cents)}`],
  ];
  return (
    <div style={{ background: "var(--field)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: 32 }}>
        <div>
          <Mono size={11} color="var(--signal-55)">
            Shuddl · Proof of delivery
          </Mono>
        </div>

        <div style={{ marginTop: 20 }}>
          <Display size="hero">Delivered</Display>
        </div>
        <div style={{ marginTop: 20 }}>
          <Divider />
        </div>

        {/* Full-bleed evidence photos — signature + placed freight, a 2-cell presentation table
            (the email-safe stand-in for a 1fr/1fr grid with a 12px gutter). */}
        <table
          role="presentation"
          cellPadding={0}
          cellSpacing={0}
          style={{ width: "100%", borderCollapse: "collapse", marginTop: 20 }}
        >
          <tbody>
            <tr>
              <td style={{ width: "50%", verticalAlign: "top", paddingRight: 6 }}>
                <PhotoSlot caption="Signature" src={data.photos.signature_url} />
              </td>
              <td style={{ width: "50%", verticalAlign: "top", paddingLeft: 6 }}>
                <PhotoSlot caption="Freight as placed" src={data.photos.placed_url} />
              </td>
            </tr>
          </tbody>
        </table>

        {/* Mono metadata over red rules — label left / value right as 2-cell table rows
            (flex justify-between does not survive mail clients). */}
        <div style={{ marginTop: 20 }}>
          {meta.map(([k, v]) => (
            <div key={k}>
              <Divider />
              <table role="presentation" cellPadding={0} cellSpacing={0} style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "10px 0", textAlign: "left" }}>
                      <Mono size={11} color="var(--signal-55)">
                        {k}
                      </Mono>
                    </td>
                    <td style={{ padding: "10px 0", textAlign: "right" }}>
                      <Mono size={12}>{v}</Mono>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <Divider />
          {/* REQ-129 — the referral surface: the email is the brand's furthest-traveling artifact. */}
          <div style={{ padding: "10px 0" }}>
            <TextLink href={data.referral_url}>Ship like this</TextLink>
          </div>
          <Divider />
        </div>

        <div style={{ marginTop: 20 }}>
          <Mono size={10} color="var(--signal-55)">
            This email is the record · Reply to dispute within 48h
          </Mono>
        </div>
      </div>
    </div>
  );
}
