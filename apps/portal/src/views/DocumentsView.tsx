import { useEffect, useState } from "react";
import { Button, Divider, EmptyState, Loading, Mono } from "@shuddl/design";
import { z } from "@shuddl/contracts";
import { ApiError, apiBase, get } from "../lib/api.js";

// REQ-085 (WP-09 Task 6/11) — the PORTAL DOCUMENTS view. It lists the selected shipment's documents through
// the caller's OWN lens (GET /v1/shipments/:id/documents) and offers a download per doc. Two honesty rules:
//   · LENS-HONEST: the server returns ONLY the docs this party may see (visibility <> 'internal', on a
//     shipment the party is on). The client NEVER filters or re-derives visibility — it renders exactly what
//     the server sends. r2_key/hash are absent from the list body by design (the bytes ride the signed URL).
//   · DOWNLOAD IS GATED SERVER-SIDE: clicking Download calls GET /v1/documents/:id/url (re-checks the SAME
//     lens) → a short-lived signed /pub/documents/<cap> URL. The cap IS the authorization; we resolve it
//     against the API origin and open it (no bearer rides the bytes fetch).

interface DocRow {
  id: string;
  shipment_id: string | null;
  party_id: string | null;
  kind: string;
  visibility: string;
}

// PARSED at the boundary (§782) — an unchecked `res.documents` could be undefined and white-screen the list
// render below. Non-strict, like the invoice seam: unknown keys are STRIPPED, so a field a future server adds
// cannot blank the page and an internal that leaked onto the wire still cannot reach the DOM.
const DocRowSchema = z.object({
  id: z.string(),
  shipment_id: z.string().nullable(),
  party_id: z.string().nullable(),
  kind: z.string(),
  visibility: z.string(),
});
const DocumentsResponse = z.object({ documents: z.array(DocRowSchema) });
const DocUrlResponse = z.object({ url: z.string(), expires_in: z.number() });

export interface DocumentsViewProps {
  shipmentId: string;
  /** Called on any ApiError.isAuthError so the board can drop the session and show the re-auth prompt. */
  onAuthError: () => void;
}

export function DocumentsView({ shipmentId, onAuthError }: DocumentsViewProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    get<unknown>(`/v1/shipments/${encodeURIComponent(shipmentId)}/documents`)
      .then((raw) => {
        if (live) setDocs(DocumentsResponse.parse(raw).documents);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.isAuthError) {
          onAuthError();
          return;
        }
        setError(e instanceof ApiError ? e.message : "COULD NOT LOAD DOCUMENTS");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [shipmentId, onAuthError]);

  async function handleDownload(id: string): Promise<void> {
    setError(null);
    try {
      // PARSED (§782): `res.url` is concatenated onto the API base and OPENED. An unchecked body could make
      // that `undefined`, navigating the user to a bogus URL; a ZodError becomes the honest error state below.
      const res = DocUrlResponse.parse(await get<unknown>(`/v1/documents/${encodeURIComponent(id)}/url`));
      // The url is a RELATIVE /pub/documents/<cap> on the API origin (never a hardcoded host). Resolve it
      // against the API base and open it in a new tab — the cap is the whole authorization.
      const bytesUrl = `${apiBase()}${res.url}`;
      window.open(bytesUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      if (e instanceof ApiError && e.isAuthError) {
        onAuthError();
        return;
      }
      setError(e instanceof ApiError ? e.message : "COULD NOT OPEN DOCUMENT");
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Mono size={10} color="var(--signal-55)">
        DOCUMENTS
      </Mono>
      {loading ? (
        <Loading label="SYNCING DOCUMENTS" />
      ) : error !== null ? (
        <Mono size={11} color="var(--signal-deep)">
          {error}
        </Mono>
      ) : docs.length === 0 ? (
        <EmptyState>No documents on this shipment</EmptyState>
      ) : (
        <div>
          {docs.map((d) => (
            <div key={d.id}>
              <Divider />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "10px 0" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <Mono size={12}>{d.kind}</Mono>
                  <Mono size={10} color="var(--signal-55)">
                    {d.visibility}
                  </Mono>
                </div>
                <Button type="button" onClick={() => void handleDownload(d.id)}>
                  Download
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
