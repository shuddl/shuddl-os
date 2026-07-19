// X12 204 motor-carrier load-tender parse → normalized TenderDoc (REQ-201). PURE adapter (REQ-035): consumes
// the tokenizer, maps N1/N3/N4 loops + G62 + AT8, and NEVER fabricates a value the wire omitted — a missing
// weight/dims stays `undefined` so the downstream rater refuses to sell ("no price on air", CLAUDE.md #4).
import { tokenize, type EdiSegment } from "./envelope.js";
import { TenderDoc, type EdiAddress, type ApptWindow, type TenderStop, type TenderBillTo } from "./types.js";

// G62 date/time qualifiers that pin the LATE / delivery end of an appointment window (everything else is
// treated as the early / pickup start). Kept as data so a new qualifier is a one-line addition.
const END_QUALIFIERS = new Set(["02", "38", "35", "70"]);

// A parsed N1 loop: the entity code (SH/CN/BT/…), its name, and the subordinate segments (N3/N4/G62/PER).
interface N1Loop {
  code: string;
  name: string;
  segs: EdiSegment[];
}

// Normalize an X12 date (CCYYMMDD) + optional time (HHMM) to an ISO-8601 local string. Pure string slicing —
// no Date object, so the result is deterministic and never shifts by the host's timezone.
function toIso(date: string, time: string | undefined): string | undefined {
  const d = date.replace(/\D/g, "");
  if (d.length < 8) return undefined;
  const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const t = (time ?? "").replace(/\D/g, "");
  if (t.length >= 4) return `${day}T${t.slice(0, 2)}:${t.slice(2, 4)}`;
  return day;
}

function addressFromLoop(segs: EdiSegment[]): EdiAddress {
  const a: EdiAddress = {};
  for (const s of segs) {
    if (s.tag === "N3") {
      const street = s.elements[0]?.trim();
      if (street) a.street = street;
    } else if (s.tag === "N4") {
      const city = s.elements[0]?.trim();
      const state = s.elements[1]?.trim();
      const zip = s.elements[2]?.trim();
      if (city) a.city = city;
      if (state) a.state = state;
      if (zip) a.zip = zip;
    }
  }
  return a;
}

function apptFromLoop(segs: EdiSegment[]): ApptWindow | undefined {
  const w: ApptWindow = {};
  for (const s of segs) {
    if (s.tag !== "G62") continue;
    const qual = s.elements[0]?.trim() ?? "";
    const iso = toIso(s.elements[1]?.trim() ?? "", s.elements[3]?.trim());
    if (iso === undefined) continue;
    if (END_QUALIFIERS.has(qual)) w.end = iso;
    else w.start = iso;
  }
  if (w.start === undefined && w.end === undefined) return undefined;
  return w;
}

// A 204 rarely carries an email; when a PER contact segment does (qualifier "EM"), it is preserved — the N1
// address and any contact are never silently dropped (Migrator rule, CLAUDE.md #10).
function emailFromLoop(segs: EdiSegment[]): string | undefined {
  for (const s of segs) {
    if (s.tag !== "PER") continue;
    // PER01 = contact function, PER02 = name, then (qualifier, value) pairs from PER03 onward.
    for (let i = 2; i + 1 < s.elements.length; i += 2) {
      if (s.elements[i]?.trim() === "EM") {
        const v = s.elements[i + 1]?.trim();
        if (v) return v;
      }
    }
  }
  return undefined;
}

export function parse204(raw: string): TenderDoc {
  const t = tokenize(raw);

  let partnerScac = "";
  let purpose: "00" | "01" = "00";
  const refs: Record<string, string> = {};
  let weightLb: number | undefined;

  const loops: N1Loop[] = [];
  let current: N1Loop | undefined;

  for (const seg of t.segments) {
    switch (seg.tag) {
      case "B2": {
        // B202 = SCAC of the tendered carrier; B204 = shipment identification number.
        const scac = seg.elements[1]?.trim();
        if (scac) partnerScac = scac;
        const sid = seg.elements[3]?.trim();
        if (sid) refs["SID"] = sid;
        break;
      }
      case "B2A": {
        const p = seg.elements[0]?.trim();
        if (p === "01") purpose = "01";
        else if (p === "00") purpose = "00";
        break;
      }
      case "L11": {
        // L1101 = reference value, L1102 = qualifier; key the ref by its qualifier.
        const val = seg.elements[0]?.trim();
        const qual = seg.elements[1]?.trim();
        if (val && qual) refs[qual] = val;
        break;
      }
      case "AT8": {
        // AT803 = weight. Left undefined when absent — never defaulted to zero.
        const raw8 = seg.elements[2]?.trim();
        if (raw8) {
          const n = Number(raw8);
          if (Number.isFinite(n)) weightLb = n;
        }
        break;
      }
      case "N1": {
        current = { code: seg.elements[0]?.trim() ?? "", name: seg.elements[1]?.trim() ?? "", segs: [] };
        loops.push(current);
        break;
      }
      case "N3":
      case "N4":
      case "G62":
      case "PER": {
        if (current) current.segs.push(seg);
        break;
      }
      default:
        break;
    }
  }

  const stops: TenderStop[] = [];
  let billTo: TenderBillTo | undefined;

  for (const loop of loops) {
    const address = addressFromLoop(loop.segs);
    if (loop.code === "SH" || loop.code === "CN") {
      const stop: TenderStop = { role: loop.code, name: loop.name, address };
      const window = apptFromLoop(loop.segs);
      if (window) stop.apptWindow = window;
      stops.push(stop);
    } else if (loop.code === "BT") {
      const bt: TenderBillTo = { name: loop.name };
      const email = emailFromLoop(loop.segs);
      if (email) bt.email = email;
      if (Object.keys(address).length > 0) bt.address = address;
      billTo = bt;
    }
  }

  const doc: TenderDoc = { partnerScac, purpose, refs, stops };
  if (billTo) doc.billTo = billTo;
  if (weightLb !== undefined) doc.weightLb = weightLb;

  // Validate at the boundary (.strict()): an unexpected shape is a hard reject, never a silent pass-through.
  return TenderDoc.parse(doc);
}
