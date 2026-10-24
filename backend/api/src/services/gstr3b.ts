/**
 * GSTR-3B working from a sales register and, when one has been run, the GSTR-2B ↔ Books result.
 *
 * It lays out what a CA needs to fill Table 3.1, 3.2, 4 and 6.1: outward supplies from the
 * register, input tax credit from GSTR-2B, and the order in which credit pays the liability.
 * It is a working, not a return. Nothing here claims credit or files anything; the CA decides
 * what is eligible, reverses what must be reversed and files on the portal. Money is paise.
 */
import { type Gstr1Result, type Heads, zeroHeads } from "./salesRegister";

export interface ItcHeads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export const zeroItc = (): ItcHeads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });

export interface ItcSource {
  runId: string | null;
  period: string | null;
  recipientGstin: string | null;
  /** All tax on GSTR-2B documents where credit is available. */
  portal: ItcHeads;
  /** The part of it that agrees with the purchase register. */
  matched: ItcHeads;
  /** In the books but not supported by GSTR-2B. */
  atRisk: ItcHeads;
  /** GSTR-2B documents marked "ITC not available". */
  notEligible: ItcHeads;
}

const toPaise = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};

function headsOf(value: unknown): ItcHeads {
  const source = (value ?? {}) as Record<string, unknown>;
  return { igst: toPaise(source.igst), cgst: toPaise(source.cgst), sgst: toPaise(source.sgst), cess: toPaise(source.cess) };
}

/** Reads the saved GSTR-2B ↔ Books artifact (rupees) into paise. Null when it has no tax-head totals. */
export function itcFromGstr2b(saved: unknown, runId: string | null = null): ItcSource | null {
  const json = saved as { period?: string | null; recipientGstin?: string | null; byHead?: Record<string, unknown> } | null;
  if (!json?.byHead || typeof json.byHead !== "object") return null;
  return {
    runId,
    period: typeof json.period === "string" ? json.period : null,
    recipientGstin: typeof json.recipientGstin === "string" ? json.recipientGstin : null,
    portal: headsOf(json.byHead.portal),
    matched: headsOf(json.byHead.matched),
    atRisk: headsOf(json.byHead.atRisk),
    notEligible: headsOf(json.byHead.notEligible),
  };
}

export interface SetOff {
  igstToIgst: number;
  igstToCgst: number;
  igstToSgst: number;
  cgstToCgst: number;
  cgstToIgst: number;
  sgstToSgst: number;
  sgstToIgst: number;
  cessToCess: number;
}

export interface Payment {
  liability: ItcHeads;
  credit: ItcHeads;
  setOff: SetOff;
  cash: ItcHeads;
  carryForward: ItcHeads;
}

/**
 * Credit pays liability in the order the GST law sets (Section 49 and Rule 88A): IGST credit first
 * against IGST, then CGST, then SGST; CGST credit against CGST, then IGST; SGST credit against
 * SGST, then IGST; cess credit only against cess. Credit that is left over carries forward.
 */
export function setOff(liabilityInput: ItcHeads, creditInput: ItcHeads): Payment {
  const liability = { ...liabilityInput };
  const credit = { ...creditInput };
  for (const heads of [liability, credit]) {
    for (const key of ["igst", "cgst", "sgst", "cess"] as const) heads[key] = Math.max(0, heads[key]);
  }
  const start = { liability: { ...liability }, credit: { ...credit } };
  const move = (from: keyof ItcHeads, to: keyof ItcHeads) => {
    const used = Math.min(credit[from], liability[to]);
    credit[from] -= used;
    liability[to] -= used;
    return used;
  };
  const used: SetOff = {
    igstToIgst: move("igst", "igst"),
    igstToCgst: move("igst", "cgst"),
    igstToSgst: move("igst", "sgst"),
    cgstToCgst: move("cgst", "cgst"),
    sgstToSgst: move("sgst", "sgst"),
    cgstToIgst: move("cgst", "igst"),
    sgstToIgst: move("sgst", "igst"),
    cessToCess: move("cess", "cess"),
  };
  return { liability: start.liability, credit: start.credit, setOff: used, cash: { ...liability }, carryForward: { ...credit } };
}

export type ItcBasis = "matched" | "portal";

export interface ThreeBAdjustments {
  /** Reverse-charge tax payable in cash, from the books (Table 3.1(d)). */
  rcm?: ItcHeads & { taxable?: number };
  /** Credit to reverse (Rule 42, 43, 38 and Section 17(5)). Entered by the CA. */
  reversal?: ItcHeads;
  /** Credit to add that is not in GSTR-2B, such as credit on reverse charge. Entered by the CA. */
  additional?: ItcHeads;
}

export interface ThreeBWorking {
  period: string | null;
  basis: ItcBasis;
  /** 3.1(a): outward taxable supplies other than zero-rated, nil-rated and exempted. */
  outward: Heads;
  /** 3.1(b): outward taxable supplies (zero-rated). Includes export rows that still need review. */
  zeroRated: Heads;
  /** 3.1(c): other outward supplies (nil-rated, exempted). */
  nilExempt: number;
  /** 3.1(d): inward supplies liable to reverse charge. */
  rcm: ItcHeads & { taxable: number };
  /** 3.2: inter-state supplies to unregistered persons, by place of supply. */
  interStateUnregistered: Array<{ pos: string; taxable: number; igst: number }>;
  itc: {
    source: ItcSource | null;
    /** 4(A): credit taken from GSTR-2B on the chosen basis. */
    available: ItcHeads;
    reversal: ItcHeads;
    additional: ItcHeads;
    /** 4(C): net credit. */
    net: ItcHeads;
    /** 4(D): credit in GSTR-2B marked not available. */
    notEligible: ItcHeads;
    /** Credit in the books that GSTR-2B does not support. Not claimed here. */
    atRisk: ItcHeads;
  };
  payment: Payment;
  /** Tax payable on reverse charge, in cash. */
  rcmCash: ItcHeads;
  warnings: string[];
}

const NET_SECTIONS = ["b2b", "b2cl", "b2cs", "cdnr", "cdnur"] as const;

export function buildGstr3b(gstr1: Gstr1Result, itc: ItcSource | null, basis: ItcBasis = "matched", adjustments: ThreeBAdjustments = {}): ThreeBWorking {
  const outward = zeroHeads();
  for (const section of NET_SECTIONS) {
    const part = gstr1.totals[section];
    outward.taxable += part.taxable;
    outward.igst += part.igst;
    outward.cgst += part.cgst;
    outward.sgst += part.sgst;
    outward.cess += part.cess;
  }
  const zeroRated = { ...gstr1.totals.exp };
  const nilExempt = gstr1.totals.nil.taxable;

  const unregistered = new Map<string, { pos: string; taxable: number; igst: number }>();
  for (const row of gstr1.b2cl) {
    const entry = unregistered.get(row.pos) ?? { pos: row.pos, taxable: 0, igst: 0 };
    for (const rate of row.rates) {
      entry.taxable += rate.taxable;
      entry.igst += rate.igst;
    }
    unregistered.set(row.pos, entry);
  }
  for (const row of gstr1.b2cs) {
    // Only inter-state rows carry IGST; intra-state small sales are not part of Table 3.2.
    if (row.igst === 0) continue;
    const entry = unregistered.get(row.pos) ?? { pos: row.pos, taxable: 0, igst: 0 };
    entry.taxable += row.taxable;
    entry.igst += row.igst;
    unregistered.set(row.pos, entry);
  }

  const warnings: string[] = [];
  const available = itc ? { ...itc[basis] } : zeroItc();
  const reversal = { ...zeroItc(), ...(adjustments.reversal ?? {}) };
  const additional = { ...zeroItc(), ...(adjustments.additional ?? {}) };
  const net: ItcHeads = {
    igst: available.igst + additional.igst - reversal.igst,
    cgst: available.cgst + additional.cgst - reversal.cgst,
    sgst: available.sgst + additional.sgst - reversal.sgst,
    cess: available.cess + additional.cess - reversal.cess,
  };
  for (const key of ["igst", "cgst", "sgst", "cess"] as const) {
    if (net[key] < 0) {
      warnings.push(`Credit reversed is more than the credit available in ${key.toUpperCase()}. The shortfall is payable in cash.`);
    }
  }
  const liability: ItcHeads = { igst: outward.igst, cgst: outward.cgst, sgst: outward.sgst, cess: outward.cess };
  for (const key of ["igst", "cgst", "sgst", "cess"] as const) {
    if (liability[key] < 0) warnings.push(`${key.toUpperCase()} is negative this month because credit notes exceed sales. It cannot be paid by credit; adjust it in the return as the law allows.`);
  }
  if (!itc) warnings.push("No GSTR-2B ↔ Books result was found for this client, so input tax credit is shown as nil. Run GSTR-2B ↔ Books for the same month first.");
  if (itc && gstr1.period && itc.period && itc.period !== gstr1.period) {
    warnings.push(`The GSTR-2B result is for ${itc.period} but the register is for ${gstr1.period}. Check that it is the right month.`);
  }
  if (itc && gstr1.sellerGstin && itc.recipientGstin && itc.recipientGstin !== gstr1.sellerGstin) {
    warnings.push(`The GSTR-2B belongs to ${itc.recipientGstin} but the register belongs to ${gstr1.sellerGstin}.`);
  }
  if (gstr1.exports.length > 0) warnings.push(`${gstr1.exports.length} export or SEZ ${gstr1.exports.length === 1 ? "document is" : "documents are"} shown under zero-rated supplies. Check them before relying on this table.`);
  const rcm = { taxable: 0, ...zeroItc(), ...(adjustments.rcm ?? {}) };
  const payment = setOff(liability, { igst: Math.max(0, net.igst), cgst: Math.max(0, net.cgst), sgst: Math.max(0, net.sgst), cess: Math.max(0, net.cess) });
  return {
    period: gstr1.period,
    basis,
    outward,
    zeroRated,
    nilExempt,
    rcm,
    interStateUnregistered: [...unregistered.values()].sort((a, b) => a.pos.localeCompare(b.pos)),
    itc: {
      source: itc,
      available,
      reversal,
      additional,
      net,
      notEligible: itc ? { ...itc.notEligible } : zeroItc(),
      atRisk: itc ? { ...itc.atRisk } : zeroItc(),
    },
    payment,
    rcmCash: { igst: rcm.igst, cgst: rcm.cgst, sgst: rcm.sgst, cess: rcm.cess },
    warnings,
  };
}
