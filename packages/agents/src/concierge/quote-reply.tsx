import { renderToStaticMarkup } from "react-dom/server";
import { Display, Divider, Mono } from "@shuddl/design";
import { formatCents } from "../biller/evidence-email-view.js";
import { inlineTokens } from "../biller/evidence-email.js";

// THE CONCIERGE QUOTE REPLY (REQ-098) — the tenant-voice, design-law-clean quote email the auto-reply
// sends. It mirrors the Biller's evidence email exactly (doc 07 §03): greige ground, a Display headline,
// the lane + the price via integer-cents formatCents, a mono metadata block, a dispute/validity footer,
// and — because mail clients strip CSS custom properties and Outlook's Word engine drops flex/grid — the
// layout is block flow + presentation tables and every var(--token) is inlined to its literal.
//
// THE TENANT VOICE IS BOUNDED, NEVER MODEL OUTPUT: the "voice" is a config-seeded from-name (`tenant_from_name`)
// plus a FIXED signature/footer template. The SENT content is deterministic and validated — the model that
// parsed the inbound never authors a single byte of the body (Task-3 C1: the email is untrusted). The only
// data that flows in are the shipment ref, the lane, the Rater's sell, an optional validity string, and the
// from-name. Pure & deterministic: no Date, no random; same data → identical bytes.

export interface QuoteReplyData {
  /** The shipment the quote is for — interpolated into the subject (a mail header), so CR/LF is rejected. */
  shipment_ref: string;
  /** The quoted lane; both zips render into the body. */
  lane: { origin_zip: string; dest_zip: string };
  /** The RATER's sell in INTEGER cents — the money never comes from the model (formatted by integer/string math). */
  sell_cents: number;
  /** Pre-formatted display string — this module stays Date-free (compose is pure; the consumer may set it). */
  valid_until?: string;
  /** REQ-098 tenant voice: the config-seeded from-name that signs the reply. Body-only, React-escaped. */
  tenant_from_name: string;
}

// React 19 hoists `<link rel="preload">` hints to the front of static markup; an email fragment has no
// <head> and mail clients drop <link>, so strip any that appear (defensive — this body has no images today).
function stripPreloadHints(html: string): string {
  return html.replace(/<link rel="preload"[^>]*\/>/g, "");
}

// A label/value metadata row as a presentation table (flex justify-between does not survive mail clients);
// mono label left over a red rule, mono value right — the exact evidence-email idiom.
function MetaRow({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div>
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
  );
}

export function QuoteReplyView({ data }: { data: QuoteReplyData }): React.JSX.Element {
  const lane = `${data.lane.origin_zip} → ${data.lane.dest_zip}`;
  const rate = formatCents(data.sell_cents);
  const meta: ReadonlyArray<[string, string]> = [
    ["Shipment", data.shipment_ref],
    ["Lane", lane],
    ["Rate", rate],
    ...(data.valid_until !== undefined ? ([["Valid until", data.valid_until]] as [string, string][]) : []),
  ];
  return (
    <div style={{ background: "var(--field)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: 32 }}>
        <div>
          <Mono size={11} color="var(--signal-55)">
            Shuddl · Rate quote
          </Mono>
        </div>

        <div style={{ marginTop: 20 }}>
          <Display size="hero">Your rate</Display>
        </div>
        <div style={{ marginTop: 20 }}>
          <Divider />
        </div>

        {/* The lane over the price, prominent — the two facts the reader wants first. */}
        <div style={{ marginTop: 20 }}>
          <Mono size={12} color="var(--signal-55)">
            {lane}
          </Mono>
        </div>
        <div style={{ marginTop: 8 }}>
          <Display size="section">{rate}</Display>
        </div>

        {/* Mono metadata over red rules. */}
        <div style={{ marginTop: 20 }}>
          {meta.map(([k, v]) => (
            <MetaRow key={k} k={k} v={v} />
          ))}
          <Divider />
        </div>

        {/* The tenant voice: a config-seeded from-name signs a FIXED signature line (never model output). */}
        <div style={{ marginTop: 20 }}>
          <Mono size={11}>{`— ${data.tenant_from_name}`}</Mono>
        </div>

        {/* The dispute/validity footer. */}
        <div style={{ marginTop: 12 }}>
          <Mono size={10} color="var(--signal-55)">
            This rate is firm · Reply to book or dispute within 48h
          </Mono>
        </div>
      </div>
    </div>
  );
}

/**
 * renderQuoteReply — the send-ready projection: a deterministic subject naming the shipment + the rate,
 * plus the email-safe html FRAGMENT (tokens inlined to literals). shipment_ref is rejected if it carries
 * CR/LF — it is interpolated into a mail header. The Biller owns the doctype + charset wrapping the sender
 * still applies (the copy uses `·` U+00B7); this returns the same {subject, html} contract as the evidence email.
 */
export function renderQuoteReply(data: QuoteReplyData): { subject: string; html: string } {
  if (/[\r\n]/.test(data.shipment_ref)) {
    throw new Error("quote-reply: shipment_ref carries CR/LF — refusing to interpolate into a mail header");
  }
  return {
    subject: `YOUR RATE · ${data.shipment_ref} · ${formatCents(data.sell_cents)}`,
    html: inlineTokens(stripPreloadHints(renderToStaticMarkup(<QuoteReplyView data={data} />))),
  };
}
