// X12 204 motor-carrier load-tender parse → normalized TenderDoc (REQ-201). PURE adapter (REQ-035): consumes
// the tokenizer, maps N1/N3/N4 loops + G62 + AT8, and NEVER fabricates a value the wire omitted — a missing
// weight/dims stays `undefined` so the downstream rater refuses to sell ("no price on air", CLAUDE.md #4).
import { tokenize, type EdiSegment } from "./envelope.js";
import { TenderDoc, type EdiAddress, type ApptWindow, type TenderStop, type TenderBillTo, type TenderDims } from "./types.js";

// A strict positive integer from an X12 element ("48" ✓; "48.5"/"0"/"-4"/"0x10"/"1e5"/"" ✗). Freight physics
// are whole units — anything else stays UNDEFINED (no price on air, never a fabricated/rounded value).
function positiveInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

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
  // Null-proto so a hostile L11 qualifier equal to an Object.prototype member (`__proto__`, `constructor`, …)
  // becomes a real own key instead of being silently dropped or hitting an inherited accessor — the wire's
  // ref is never lost or corrupted (Migrator rule, CLAUDE.md #10).
  const refs: Record<string, string> = Object.create(null);
  let weightLb: number | undefined;
  // Measured dims (l/w/h inches, from an inch-unit L4) + pieces (AT8 AT804 lading quantity). Undefined until a
  // VALID segment sets them; a later blank/invalid segment never clears an earlier valid value (no silent drop).
  let lengthIn: number | undefined;
  let widthIn: number | undefined;
  let heightIn: number | undefined;
  let pieces: number | undefined;

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
        // AT803 = weight. Accept ONLY a strict positive decimal — `Number()` would let "-500", "0x10",
        // "1e5" through and feed the rater a bogus/negative weight, which is worse than the UNKNOWN that
        // "no price on air" (CLAUDE.md #4) preserves. Anything else leaves weightLb undefined.
        const raw8 = seg.elements[2]?.trim();
        if (raw8 !== undefined && /^\d+(\.\d+)?$/.test(raw8)) {
          const n = Number(raw8);
          if (n > 0) weightLb = n;
        }
        // AT804 = lading quantity (handling units) = the piece count the rater's dims gate needs. LAST-VALID
        // wins: a later blank/invalid AT8 never clears a piece count an earlier AT8 already set.
        const p = positiveInt(seg.elements[3]);
        if (p !== undefined) pieces = p;
        break;
      }
      case "L4": {
        // L4 Measurement: L401=length, L402=width, L403=height, L404=unit qualifier. Accept a dimension ONLY
        // when the unit is inches ("IN") AND every value is a positive integer — a CM/FT/zero/absent value
        // leaves l/w/h UNKNOWN (no price on air, CLAUDE.md #4: never fabricate a dimension in an unknown unit).
        // Set as a unit (all three or none) and LAST-VALID wins.
        if (seg.elements[3]?.trim().toUpperCase() === "IN") {
          const l = positiveInt(seg.elements[0]);
          const w = positiveInt(seg.elements[1]);
          const h = positiveInt(seg.elements[2]);
          if (l !== undefined && w !== undefined && h !== undefined) {
            lengthIn = l;
            widthIn = w;
            heightIn = h;
          }
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

  // Assemble dims from whatever VALID measured physics the wire carried (l/w/h only when an inch-unit L4 set
  // them; pieces from AT8). A partial dims (e.g. pieces but no l/w/h) is kept — the downstream rater treats an
  // incomplete dims as UNKNOWN (no price on air), never a fabricated value.
  const dims: TenderDims = {};
  if (lengthIn !== undefined) dims.lengthIn = lengthIn;
  if (widthIn !== undefined) dims.widthIn = widthIn;
  if (heightIn !== undefined) dims.heightIn = heightIn;
  if (pieces !== undefined) dims.pieces = pieces;
  if (Object.keys(dims).length > 0) doc.dims = dims;

  // Validate at the boundary (.strict()): an unexpected shape is a hard reject, never a silent pass-through.
  // zod's z.record rebuilds refs on a {}-proto object and drops a literal `__proto__` key, so re-attach the
  // prototype-safe `refs` (already validated as string→string by the parse above) — no ref is silently lost.
  const validated = TenderDoc.parse(doc);
  return { ...validated, refs };
}
