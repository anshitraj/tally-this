/**
 * Summaries and GSTR-1 working figures from normalized events. Marketplace-independent and pure.
 *
 * Treatment, stated once: an event belongs to the GST period it was reported in. Returns and credit notes reduce the
 * period in which they are reported, not the period of the original sale, so net = sales − returns − credit notes for
 * the period. Duplicates are never passed in. Every figure is added in whole paise.
 */
import { aggregateTax, b2clThreshold, rateText, type RoundingMode, type SupplyType } from "./gstEngine";
import { sum, type Paise } from "./money";
import { stateName } from "../gstStates";

export interface SummaryEvent {
  id: number;
  eventType: string;
  sellerGstin: string | null;
  orderId: string | null;
  subOrderId: string | null;
  reportPeriod: string;
  hsn: string | null;
  description: string | null;
  uqc: string | null;
  quantity: number;
  taxable: Paise;
  rateMilli: number | null;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  invoiceValue: Paise;
  placeOfSupply: string | null;
  supplyType: SupplyType;
  ecoGstin: string | null;
  documentNumber: string | null;
  /** Tax that could not be split into IGST or CGST and SGST because the place of supply is unknown. */
  unsplitTax: Paise;
}

export interface Totals {
  count: number;
  quantity: number;
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
  tax: Paise;
  invoiceValue: Paise;
  /** Tax that could not be split because the place of supply is unknown. */
  unassignedTax: Paise;
}

export function emptyTotals(): Totals {
  return { count: 0, quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0, invoiceValue: 0, unassignedTax: 0 };
}

const REDUCES = new Set(["return", "cancellation", "credit_note"]);

export function isReduction(eventType: string) {
  return REDUCES.has(eventType);
}

function eventTax(e: SummaryEvent) {
  return e.igst + e.cgst + e.sgst + e.cess;
}

/** Tax on an event whose supply type is unknown is held apart: it is in `tax` but not in IGST, CGST or SGST. */
function addTo(t: Totals, e: SummaryEvent, unassigned: Paise) {
  t.count += 1;
  t.quantity = Math.round((t.quantity + e.quantity) * 1000) / 1000;
  t.taxable = sum([t.taxable, e.taxable]);
  t.igst += e.igst;
  t.cgst += e.cgst;
  t.sgst += e.sgst;
  t.cess += e.cess;
  t.tax += eventTax(e) + unassigned;
  t.invoiceValue = sum([t.invoiceValue, e.invoiceValue]);
  t.unassignedTax += unassigned;
}

/**
 * CGST and SGST are equal halves of intra-State tax. The reports give one tax amount per line, and splitting each line
 * leaves an odd paisa that would always land on the same side; over a month that adds up. So a group's CGST + SGST is
 * split once, evenly (an odd paisa to CGST), and the total tax is exactly what the lines say.
 */
export function evenSplit(t: Totals): Totals {
  const both = t.cgst + t.sgst;
  const sgst = both >= 0 ? Math.floor(both / 2) : Math.ceil(both / 2);
  return { ...t, cgst: both - sgst, sgst };
}

export function netOf(sales: Totals, ...reductions: Totals[]): Totals {
  return evenSplit(netRaw(sales, ...reductions));
}

function netRaw(sales: Totals, ...reductions: Totals[]): Totals {
  const net = { ...sales };
  for (const r of reductions) {
    net.count += r.count;
    net.quantity = Math.round((net.quantity - r.quantity) * 1000) / 1000;
    net.taxable -= r.taxable;
    net.igst -= r.igst;
    net.cgst -= r.cgst;
    net.sgst -= r.sgst;
    net.cess -= r.cess;
    net.tax -= r.tax;
    net.invoiceValue -= r.invoiceValue;
    net.unassignedTax -= r.unassignedTax;
  }
  return net;
}

export interface Overview {
  period: string;
  sales: Totals;
  returns: Totals;
  creditNotes: Totals;
  net: Totals;
  byRate: Array<{ rate: string; sales: Paise; reductions: Paise; net: Paise; tax: Paise }>;
  byMonth: Array<{ period: string; sales: Paise; returns: Paise }>;
}

export function overview(events: SummaryEvent[], period: string): Overview {
  const sales = emptyTotals();
  const returns = emptyTotals();
  const creditNotes = emptyTotals();
  const rates = new Map<string, { sales: Paise; reductions: Paise; tax: Paise }>();
  for (const e of events) {
    const bucket = e.eventType === "sale" ? sales : e.eventType === "credit_note" ? creditNotes : isReduction(e.eventType) ? returns : null;
    if (!bucket) continue;
    addTo(bucket, e, e.unsplitTax);
    const rate = rateText(e.rateMilli) || "unknown";
    const r = rates.get(rate) ?? { sales: 0, reductions: 0, tax: 0 };
    if (e.eventType === "sale") {
      r.sales += e.taxable;
      r.tax += eventTax(e) + e.unsplitTax;
    } else {
      r.reductions += e.taxable;
      r.tax -= eventTax(e) + e.unsplitTax;
    }
    rates.set(rate, r);
  }
  const [s, r, c] = [evenSplit(sales), evenSplit(returns), evenSplit(creditNotes)];
  return {
    period,
    sales: s,
    returns: r,
    creditNotes: c,
    net: netOf(s, r, c),
    byRate: [...rates.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([rate, r]) => ({ rate, sales: r.sales, reductions: r.reductions, net: r.sales - r.reductions, tax: r.tax })),
    byMonth: [],
  };
}

export interface HsnRow {
  hsn: string;
  description: string | null;
  uqc: string;
  rate: string;
  sales: Totals;
  returns: Totals;
  net: Totals;
}

function retax(t: Totals, rateMilli: number | null, type: SupplyType, mode: RoundingMode): Totals {
  if (mode === "line" || rateMilli == null || type === "unknown") return evenSplit(t);
  const split = aggregateTax(t.taxable, rateMilli, type);
  return { ...t, igst: split.igst, cgst: split.cgst, sgst: split.sgst, tax: split.igst + split.cgst + split.sgst + t.cess };
}

/**
 * HSN-wise summary (GSTR-1 Table 12 shape): one row per HSN and rate, with sales, returns (including credit notes) and
 * the net. "aggregate" rounding works the tax out once per HSN, rate and supply type instead of adding each line's tax.
 */
export function hsnSummary(events: SummaryEvent[], mode: RoundingMode = "line"): HsnRow[] {
  type Group = { hsn: string; description: string | null; uqc: string; rateMilli: number | null; parts: Map<SupplyType, { sales: Totals; returns: Totals }> };
  const groups = new Map<string, Group>();
  for (const e of events) {
    const hsn = e.hsn || "(no HSN)";
    const k = `${hsn}|${e.rateMilli ?? ""}`;
    const g = groups.get(k) ?? { hsn, description: e.description, uqc: e.uqc || "OTH", rateMilli: e.rateMilli, parts: new Map() };
    const part = g.parts.get(e.supplyType) ?? { sales: emptyTotals(), returns: emptyTotals() };
    if (e.eventType === "sale") addTo(part.sales, e, e.unsplitTax);
    else if (isReduction(e.eventType)) addTo(part.returns, e, e.unsplitTax);
    g.parts.set(e.supplyType, part);
    groups.set(k, g);
  }
  const rows: HsnRow[] = [];
  for (const g of groups.values()) {
    const sales = emptyTotals();
    const returns = emptyTotals();
    for (const [type, part] of g.parts) {
      for (const [target, source] of [[sales, retax(part.sales, g.rateMilli, type, mode)], [returns, retax(part.returns, g.rateMilli, type, mode)]] as const) {
        target.count += source.count;
        target.quantity = Math.round((target.quantity + source.quantity) * 1000) / 1000;
        target.taxable += source.taxable;
        target.igst += source.igst;
        target.cgst += source.cgst;
        target.sgst += source.sgst;
        target.cess += source.cess;
        target.tax += source.tax;
        target.invoiceValue += source.invoiceValue;
        target.unassignedTax += source.unassignedTax;
      }
    }
    rows.push({ hsn: g.hsn, description: g.description, uqc: g.uqc, rate: rateText(g.rateMilli) || "unknown", sales: evenSplit(sales), returns: evenSplit(returns), net: netOf(sales, returns) });
  }
  return rows.sort((a, b) => a.hsn.localeCompare(b.hsn) || Number(a.rate) - Number(b.rate));
}

export interface StateRow {
  pos: string;
  posName: string;
  rate: string;
  supplyType: SupplyType;
  ecoGstin: string | null;
  sales: Totals;
  returns: Totals;
  net: Totals;
}

/** Place-of-supply-wise figures: the shape of GSTR-1 Table 7 (B2C small), with returns netted in the period. */
export function stateSummary(events: SummaryEvent[], mode: RoundingMode = "line"): StateRow[] {
  const groups = new Map<string, StateRow & { rateMilli: number | null }>();
  for (const e of events) {
    const pos = e.placeOfSupply ?? "??";
    const k = `${pos}|${e.rateMilli ?? ""}|${e.ecoGstin ?? ""}|${e.supplyType}`;
    const g = groups.get(k) ?? { pos, posName: stateName(pos) ?? "Unknown State", rate: rateText(e.rateMilli) || "unknown", rateMilli: e.rateMilli, supplyType: e.supplyType, ecoGstin: e.ecoGstin, sales: emptyTotals(), returns: emptyTotals(), net: emptyTotals() };
    if (e.eventType === "sale") addTo(g.sales, e, e.unsplitTax);
    else if (isReduction(e.eventType)) addTo(g.returns, e, e.unsplitTax);
    groups.set(k, g);
  }
  return [...groups.values()].map(g => {
    const sales = retax(g.sales, g.rateMilli, g.supplyType, mode);
    const returns = retax(g.returns, g.rateMilli, g.supplyType, mode);
    const { rateMilli: _ignored, ...row } = g;
    return { ...row, sales, returns, net: netOf(sales, returns) };
  }).sort((a, b) => a.pos.localeCompare(b.pos) || Number(a.rate) - Number(b.rate));
}

export interface DocumentSeries { prefix: string; from: string; to: string; count: number }

function series(numbers: string[]): DocumentSeries[] {
  const byPrefix = new Map<string, Array<{ text: string; n: number }>>();
  for (const text of new Set(numbers)) {
    const m = /^(.*?)(\d+)$/.exec(text);
    const prefix = m ? m[1] : text;
    const n = m ? Number(m[2]) : 0;
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), { text, n }]);
  }
  return [...byPrefix.entries()].map(([prefix, items]) => {
    items.sort((a, b) => a.n - b.n);
    return { prefix, from: items[0].text, to: items[items.length - 1].text, count: items.length };
  }).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export interface Gstr1Working {
  period: string;
  rounding: RoundingMode;
  b2cs: Array<{ type: "E" | "OE"; pos: string; posName: string; rate: string; ecoGstin: string | null; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise; cess: Paise; negative: boolean }>;
  b2clCandidates: Array<{ reference: string; pos: string | null; invoiceValue: Paise; taxable: Paise }>;
  table12: HsnRow[];
  table13: { available: boolean; reason?: string; invoices: DocumentSeries[]; creditNotes: DocumentSeries[] };
  table14a: Array<{ ecoGstin: string; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise; cess: Paise }>;
  tcs: { netTaxable: Paise; expected: Paise; rate: string; note: string };
  unassigned: { count: number; taxable: Paise };
  notes: string[];
}

export function gstr1Working(events: SummaryEvent[], period: string, mode: RoundingMode = "line"): Gstr1Working {
  const states = stateSummary(events, mode);
  const known = states.filter(row => row.supplyType !== "unknown");
  const b2cs = known.map(row => ({
    type: (row.ecoGstin ? "E" : "OE") as "E" | "OE",
    pos: row.pos,
    posName: row.posName,
    rate: row.rate,
    ecoGstin: row.ecoGstin,
    taxable: row.net.taxable,
    igst: row.net.igst,
    cgst: row.net.cgst,
    sgst: row.net.sgst,
    cess: row.net.cess,
    negative: row.net.taxable < 0,
  }));

  // Inter-State B2C invoices above the threshold belong in B2C (Large); without invoice numbers the order is the unit.
  const invoices = new Map<string, { pos: string | null; invoiceValue: Paise; taxable: Paise }>();
  for (const e of events) {
    if (e.eventType !== "sale" || e.supplyType !== "inter") continue;
    const ref = e.documentNumber ?? e.orderId ?? e.subOrderId ?? String(e.id);
    const g = invoices.get(ref) ?? { pos: e.placeOfSupply, invoiceValue: 0, taxable: 0 };
    g.invoiceValue += e.invoiceValue;
    g.taxable += e.taxable;
    invoices.set(ref, g);
  }
  const threshold = b2clThreshold(period);
  const b2clCandidates = [...invoices.entries()].filter(([, g]) => g.invoiceValue > threshold).map(([reference, g]) => ({ reference, ...g }));

  const invoiceNumbers = events.filter(e => e.eventType === "sale" && e.documentNumber).map(e => e.documentNumber as string);
  const creditNumbers = events.filter(e => isReduction(e.eventType) && e.documentNumber).map(e => e.documentNumber as string);
  const withDocs = events.filter(e => e.documentNumber).length;
  const table13 = withDocs === 0
    ? { available: false, reason: "No invoice or credit-note numbers were imported. Add Tax_invoice_details.xlsx from the Meesho Supplier Panel (Payments → Tax Invoice).", invoices: [], creditNotes: [] }
    : { available: true, invoices: series(invoiceNumbers), creditNotes: series(creditNumbers), reason: withDocs < events.length ? `${events.length - withDocs} transaction(s) have no document number yet.` : undefined };

  const eco = new Map<string, { taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise; cess: Paise }>();
  for (const row of known) {
    if (!row.ecoGstin) continue;
    const g = eco.get(row.ecoGstin) ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    g.taxable += row.net.taxable;
    g.igst += row.net.igst;
    g.cgst += row.net.cgst;
    g.sgst += row.net.sgst;
    g.cess += row.net.cess;
    eco.set(row.ecoGstin, g);
  }
  const table14a = [...eco.entries()].map(([ecoGstin, g]) => ({ ecoGstin, ...g }));
  const ecoNet = sum(table14a.map(row => row.taxable));
  // Section 52 TCS: 1% until 9 July 2024, 0.5% from 10 July 2024.
  const tcsRateMilli = period >= "2024-08" ? 500 : period <= "2024-06" ? 1000 : 500;
  const tcsExpected = Math.round((ecoNet * tcsRateMilli) / 100_000);

  const unknown = states.filter(row => row.supplyType === "unknown");
  return {
    period,
    rounding: mode,
    b2cs,
    b2clCandidates,
    table12: hsnSummary(events, mode),
    table13,
    table14a,
    tcs: {
      netTaxable: ecoNet,
      expected: tcsExpected,
      rate: rateText(tcsRateMilli),
      note: period === "2024-07"
        ? "July 2024 straddles the TCS rate change (1% to 0.5% from 10 July); work this month out by date."
        : "What the operator should have collected under Section 52, worked out from the net value. It is not output tax; compare it with the TCS credit shown on the GST portal.",
    },
    unassigned: { count: sum(unknown.map(row => row.sales.count + row.returns.count)), taxable: sum(unknown.map(row => row.net.taxable)) },
    notes: [
      "Table 7 (B2C Others) is reported net of returns in the period, by place of supply and rate, as supplies through the e-commerce operator (type E) against its GSTIN.",
      "Table 14(a) repeats those supplies by operator GSTIN for information. The tax is already in Table 7; do not pay or add it twice.",
      "From the May 2025 period Table 12 separates B2B and B2C. All these supplies are B2C: the reports carry no buyer GSTIN.",
      "A draft for CA review, not a filing-ready return. Potential risk — needs CA review.",
    ],
  };
}

export interface CaComparisonRow {
  hsn: string;
  ca: { count: number | null; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise };
  ours: { count: number; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise } | null;
  difference: { taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise } | null;
}

/**
 * Compares a CA's HSN pivot with TallyThis's figures. A CA pivot usually shows gross sales per HSN with returns counted
 * on a separate line, so it is compared with gross sales, not the net. Differences are shown, never forced to zero.
 */
export function compareWithCa(ca: Array<{ hsn: string; count: number | null; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise }>, rows: HsnRow[]): CaComparisonRow[] {
  const ours = new Map<string, { count: number; taxable: Paise; igst: Paise; cgst: Paise; sgst: Paise }>();
  for (const row of rows) {
    const g = ours.get(row.hsn) ?? { count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    g.count += row.sales.count;
    g.taxable += row.sales.taxable;
    g.igst += row.sales.igst;
    g.cgst += row.sales.cgst;
    g.sgst += row.sales.sgst;
    ours.set(row.hsn, g);
  }
  return ca.filter(row => !/^grand\s*total$/i.test(row.hsn)).map(row => {
    const mine = ours.get(row.hsn) ?? null;
    return {
      hsn: row.hsn,
      ca: { count: row.count, taxable: row.taxable, igst: row.igst, cgst: row.cgst, sgst: row.sgst },
      ours: mine,
      difference: mine ? { taxable: mine.taxable - row.taxable, igst: mine.igst - row.igst, cgst: mine.cgst - row.cgst, sgst: mine.sgst - row.sgst } : null,
    };
  });
}
