import { renderToStaticMarkup } from "react-dom/server";
import { Display, Divider, Mono } from "@shuddl/design";
import { formatCents } from "../biller/evidence-email-view.js";
import { inlineTokens } from "../biller/evidence-email.js";
import { DUNNING_TONES, type DunningBucket } from "./aging.js";

// WP-11 Task 6 — THE COLLECTOR's tone-matched dunning DRAFT render (REQ-032). It mirrors the Concierge quote
// reply (quote-reply.tsx) exactly: greige ground, a Display headline, integer-cents formatCents, a mono
// metadata block over red rules, a config-seeded from-name signature, and — because mail clients strip CSS
// custom properties — every var(--token) inlined to its literal via inlineTokens.
//
// THE TONE IS A FIXED TEMPLATE, NEVER MODEL OUTPUT: the escalating copy (reminder / past-due / final) is
// keyed by the aging BUCKET (DUNNING_TONES), and the "voice" is a config-seeded from-name — the SENT content
// is deterministic and validated. No LLM authors a byte (v1 dunning is intentionally LLM-free; a tone-polish
// is a later CONFIRM). Pure & deterministic: no Date, no random; same data → identical bytes. This is DRAFT
// content only — the Collector NEVER sends; Task 7 owns the human-initiated review-and-send.

export interface DunningDraftData {
  /** The invoice being dunned — interpolated into the subject (a mail header), so CR/LF is rejected. */
  invoice_ref: string;
  /** The amount due in INTEGER cents — money never a float (formatCents throws on a non-integer/negative). */
  amount_cents: number;
  /** Whole days overdue (the sweep computes it from the injected clock); rendered as an honest metadata line. */
  days_overdue: number;
  /** The escalation bucket — selects the FIXED tone (DUNNING_TONES). */
  bucket: DunningBucket;
  /** REQ-032 tenant voice: the config-seeded from-name that signs the draft. Body-only, React-escaped. */
  tenant_from_name: string;
}

// "N day(s) overdue" with SINGULAR "1 day". A whole, non-negative count already (overdueDays floors + clamps).
function overdueLabel(days: number): string {
  return `${days} day${days === 1 ? "" : "s"} overdue`;
}

// React 19 hoists `<link rel="preload">` hints to the front of static markup; an email fragment has no <head>
// and mail clients drop <link>, so strip any that appear (defensive — this body has no images today).
function stripPreloadHints(html: string): string {
  return html.replace(/<link rel="preload"[^>]*\/>/g, "");
}

// A label/value metadata row as a presentation table (flex justify-between does not survive mail clients);
// mono label left over a red rule, mono value right — the exact evidence-email / quote-reply idiom.
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

export function DunningDraftView({ data }: { data: DunningDraftData }): React.JSX.Element {
  const tone = DUNNING_TONES[data.bucket];
  const amount = formatCents(data.amount_cents);
  const meta: ReadonlyArray<[string, string]> = [
    ["Invoice", data.invoice_ref],
    ["Amount due", amount],
    ["Status", overdueLabel(data.days_overdue)],
  ];
  return (
    <div style={{ background: "var(--field)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: 32 }}>
        <div>
          <Mono size={11} color="var(--signal-55)">
            {tone.eyebrow}
          </Mono>
        </div>

        <div style={{ marginTop: 20 }}>
          <Display size="hero">{tone.headline}</Display>
        </div>
        <div style={{ marginTop: 20 }}>
          <Divider />
        </div>

        {/* The amount due, prominent — the fact the reader wants first. */}
        <div style={{ marginTop: 20 }}>
          <Mono size={12} color="var(--signal-55)">
            Amount due
          </Mono>
        </div>
        <div style={{ marginTop: 8 }}>
          <Display size="section">{amount}</Display>
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

        {/* The escalating ask (the FIXED per-bucket tone). */}
        <div style={{ marginTop: 12 }}>
          <Mono size={10} color="var(--signal-55)">
            {tone.footer}
          </Mono>
        </div>
      </div>
    </div>
  );
}

/**
 * renderDunningDraft — the review-ready projection: a deterministic subject (the bucket tag + the invoice +
 * the amount) plus the email-safe html FRAGMENT (tokens inlined to literals). invoice_ref is rejected if it
 * carries CR/LF — it is interpolated into a mail header. Returns the SAME {subject, html} contract as the
 * evidence email / quote reply. NOTHING here sends — Task 7 owns the human-initiated send.
 */
export function renderDunningDraft(data: DunningDraftData): { subject: string; html: string } {
  if (/[\r\n]/.test(data.invoice_ref)) {
    throw new Error("dunning: invoice_ref carries CR/LF — refusing to interpolate into a mail header");
  }
  const tone = DUNNING_TONES[data.bucket];
  return {
    subject: `${tone.subjectTag} · Invoice ${data.invoice_ref} · ${formatCents(data.amount_cents)}`,
    html: inlineTokens(stripPreloadHints(renderToStaticMarkup(<DunningDraftView data={data} />))),
  };
}
