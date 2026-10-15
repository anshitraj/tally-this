import ExcelJS from "exceljs";
import { z } from "zod";

const money = z.number().finite();

const sideSchema = z.object({
  docNumber: z.string().max(120),
  docDate: z.string().max(20).nullable(),
  row: z.number().int().nonnegative(),
  voucherNo: z.string().max(80).nullable().optional(),
  taxable: money,
  igst: money,
  cgst: money,
  sgst: money,
  cess: money,
  tax: money,
  total: money,
});

const itemSchema = z.object({
  key: z.string().max(40),
  bucket: z.enum(["matched", "value_mismatch", "probable", "missing_in_2b", "missing_in_books", "not_eligible", "duplicate"]),
  status: z.enum(["suggested", "approved", "rejected", "needs_info"]),
  confidence: z.enum(["exact", "tolerance", "review"]),
  supplierGstin: z.string().max(20),
  supplierName: z.string().max(200),
  docNumber: z.string().max(120),
  docDate: z.string().max(20).nullable(),
  kind: z.enum(["invoice", "note"]),
  books: sideSchema.optional(),
  portal: sideSchema.optional(),
  diff: z.object({ taxable: money, igst: money, cgst: money, sgst: money, cess: money, tax: money }).optional(),
  why: z.array(z.string().max(400)).max(12),
  itcAtRisk: money,
  itcUnclaimed: money,
});

const headsSchema = z.object({ igst: money, cgst: money, sgst: money, cess: money, total: money });

export const gstrWorkbookSchema = z.object({
  clientName: z.string().max(200).default("Client"),
  period: z.string().max(20).nullable().optional(),
  periods: z.array(z.string().max(20)).max(24).optional(),
  recipientGstin: z.string().max(20).nullable().optional(),
  items: z.array(itemSchema).max(60000),
  totals: z.object({
    portalTax: money,
    booksTax: money,
    matchedTax: money,
    itcAtRisk: money,
    itcUnclaimed: money,
    notEligibleTax: money,
  }),
  counts: z.record(z.string(), z.number()),
  byHead: z
    .object({ portal: headsSchema, books: headsSchema, matched: headsSchema, atRisk: headsSchema, unclaimed: headsSchema, notEligible: headsSchema })
    .optional(),
  vendors: z
    .array(
      z.object({
        gstin: z.string().max(20),
        name: z.string().max(200),
        booksDocs: z.number().int().nonnegative(),
        portalDocs: z.number().int().nonnegative(),
        matched: z.number().int().nonnegative(),
        differing: z.number().int().nonnegative(),
        missingIn2b: z.number().int().nonnegative(),
        missingInBooks: z.number().int().nonnegative(),
        booksTax: money,
        portalTax: money,
        itcAtRisk: money,
        itcUnclaimed: money,
      }),
    )
    .max(20000)
    .optional(),
  suppliers: z
    .array(
      z.object({
        gstin: z.string().max(20),
        name: z.string().max(200),
        missing: z.array(z.object({ docNumber: z.string().max(120), docDate: z.string().max(20).nullable(), tax: money, total: money })).max(2000),
        mismatched: z.number().int().nonnegative(),
        itcAtRisk: money,
      }),
    )
    .max(5000),
  notes: z.array(z.string().max(400)).max(40).default([]),
});

export type GstrWorkbookInput = z.infer<typeof gstrWorkbookSchema>;
type Item = GstrWorkbookInput["items"][number];

const MONEY = "#,##0.00;[Red](#,##0.00)";

const BUCKET_LABEL: Record<Item["bucket"], string> = {
  matched: "Matched",
  value_mismatch: "Amounts differ",
  probable: "Probable match — confirm",
  missing_in_2b: "In books, not in GSTR-2B",
  missing_in_books: "In GSTR-2B, not in books",
  not_eligible: "ITC not available in GSTR-2B",
  duplicate: "Entered twice in books",
};

/** What a decision means depends on the kind of difference it was made on. */
function decisionLabel(bucket: Item["bucket"], status: Item["status"]) {
  if (bucket === "matched") return "Matched";
  if (status === "suggested") return "Not reviewed";
  if (status === "needs_info") return "Ask supplier";
  if (bucket === "missing_in_books") return status === "approved" ? "To be booked" : "Not our purchase";
  if (bucket === "probable" || bucket === "value_mismatch") return status === "approved" ? "Confirmed" : "Not a match";
  return status === "approved" ? "Noted" : "Ignored";
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF143E2C" } };
  row.height = 24;
  row.alignment = { vertical: "middle", wrapText: true };
}

function dateCell(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : (value ?? "");
}

function monthLabel(period: string | null | undefined) {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return "Not stated in the file";
  return new Date(`${period}-01T00:00:00.000Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The message a CA sends to a supplier about invoices that are missing from GSTR-2B. */
export function supplierMessage(supplier: GstrWorkbookInput["suppliers"][number], period: string | null | undefined, sender: string) {
  const lines = supplier.missing.slice(0, 25).map(doc => `• ${doc.docNumber}${doc.docDate ? ` dated ${doc.docDate}` : ""} — GST ₹${doc.tax.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
  return [
    `Dear ${supplier.name || "Sir/Madam"},`,
    "",
    `The following invoices from you (GSTIN ${supplier.gstin}) are in our books but do not appear in our GSTR-2B${period ? ` for ${monthLabel(period)}` : ""}:`,
    ...lines,
    supplier.missing.length > 25 ? `…and ${supplier.missing.length - 25} more.` : "",
    "",
    "Please check that these were reported in your GSTR-1 / IFF and filed, so that we can claim input tax credit on them.",
    "",
    `Regards,`,
    sender,
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

/** Working copy of the reconciliation. It reports differences; it does not decide ITC eligibility. */
export function buildGstrWorkbook(input: GstrWorkbookInput, sender = "Accounts team") {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 44 }, { width: 24 }, { width: 60 }];
  summary.addRow(["GSTR-2B reconciliation with purchase register"]);
  summary.getCell("A1").font = { bold: true, size: 16, color: { argb: "FF143E2C" } };
  summary.addRow([]);
  const facts: Array<[string, string | number, string?]> = [
    ["Client", input.clientName],
    ["GSTR-2B period", input.periods && input.periods.length > 1 ? input.periods.map(month => monthLabel(month)).join(", ") : monthLabel(input.period)],
    ["Recipient GSTIN in GSTR-2B", input.recipientGstin || "Not stated in the file"],
    ["Documents in GSTR-2B", input.counts.portal ?? 0],
    ["Documents in purchase register", input.counts.books ?? 0],
  ];
  for (const fact of facts) summary.addRow(fact);
  summary.addRow([]);
  summary.addRow(["Result", "Documents"]);
  summary.getRow(summary.rowCount).font = { bold: true };
  for (const bucket of ["matched", "value_mismatch", "probable", "missing_in_2b", "missing_in_books", "not_eligible", "duplicate"] as const) {
    summary.addRow([BUCKET_LABEL[bucket], input.counts[bucket] ?? 0]);
  }
  summary.addRow([]);
  summary.addRow(["Tax (IGST + CGST + SGST + cess)", "Amount ₹"]);
  summary.getRow(summary.rowCount).font = { bold: true };
  const taxRows: Array<[string, number, string]> = [
    ["In GSTR-2B where ITC is available", input.totals.portalTax, ""],
    ["In purchase register", input.totals.booksTax, ""],
    ["Matched", input.totals.matchedTax, "Agrees with GSTR-2B"],
    ["In books but not supported by GSTR-2B", input.totals.itcAtRisk, "Potential risk — needs CA review before claiming"],
    ["In GSTR-2B but not in books", input.totals.itcUnclaimed, "May be unrecorded purchases"],
    ["GSTR-2B marks ITC as not available", input.totals.notEligibleTax, ""],
  ];
  for (const [label, amount, note] of taxRows) {
    const row = summary.addRow([label, amount, note]);
    row.getCell(2).numFmt = MONEY;
  }
  if (input.byHead) {
    summary.addRow([]);
    summary.addRow(["ITC by tax head, ₹", "IGST", "CGST", "SGST", "Cess", "Total"]);
    summary.getRow(summary.rowCount).font = { bold: true };
    const head = input.byHead;
    const rows: Array<[string, z.infer<typeof headsSchema>]> = [
      ["As per GSTR-2B, ITC available", head.portal],
      ["As per purchase register", head.books],
      ["Matched", head.matched],
      ["In books, not supported by GSTR-2B", head.atRisk],
      ["In GSTR-2B, not in books", head.unclaimed],
      ["GSTR-2B marks ITC not available", head.notEligible],
    ];
    for (const [label, value] of rows) {
      const row = summary.addRow([label, value.igst, value.cgst, value.sgst, value.cess, value.total]);
      for (let col = 2; col <= 6; col += 1) row.getCell(col).numFmt = MONEY;
    }
    summary.columns = [{ width: 44 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 18 }];
  }
  if (input.notes.length > 0) {
    summary.addRow([]);
    summary.addRow(["Notes"]);
    summary.getRow(summary.rowCount).font = { bold: true };
    for (const note of input.notes) summary.addRow([note]);
  }
  summary.addRow([]);
  summary.addRow([
    "This is a working copy built from the two files you uploaded. It lists differences for review; it does not decide whether ITC can be claimed. Potential risk — needs CA review.",
  ]);

  const columns = [
    { header: "Result", key: "result", width: 28 },
    { header: "Your decision", key: "decision", width: 20 },
    { header: "Supplier GSTIN", key: "gstin", width: 20 },
    { header: "Supplier", key: "supplier", width: 28 },
    { header: "Invoice / note no.", key: "doc", width: 22 },
    { header: "Date", key: "date", width: 13 },
    { header: "Books taxable", key: "bTaxable", width: 16 },
    { header: "Books IGST", key: "bIgst", width: 14 },
    { header: "Books CGST", key: "bCgst", width: 14 },
    { header: "Books SGST", key: "bSgst", width: 14 },
    { header: "Books total", key: "bTotal", width: 16 },
    { header: "GSTR-2B taxable", key: "pTaxable", width: 16 },
    { header: "GSTR-2B IGST", key: "pIgst", width: 14 },
    { header: "GSTR-2B CGST", key: "pCgst", width: 14 },
    { header: "GSTR-2B SGST", key: "pSgst", width: 14 },
    { header: "GSTR-2B total", key: "pTotal", width: 16 },
    { header: "Tax difference", key: "diff", width: 15 },
    { header: "ITC at risk", key: "risk", width: 14 },
    { header: "ITC not in books", key: "unclaimed", width: 16 },
    { header: "Why", key: "why", width: 70 },
    { header: "Books row", key: "bRow", width: 11 },
    { header: "GSTR-2B row", key: "pRow", width: 12 },
  ];

  const addSheet = (name: string, items: Item[]) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns;
    styleHeader(sheet);
    for (const item of items) {
      const row = sheet.addRow({
        result: BUCKET_LABEL[item.bucket],
        decision: decisionLabel(item.bucket, item.status),
        gstin: item.supplierGstin,
        supplier: item.supplierName,
        doc: item.docNumber + (item.kind === "note" ? " (credit/debit note)" : ""),
        date: dateCell(item.docDate),
        bTaxable: item.books?.taxable ?? null,
        bIgst: item.books?.igst ?? null,
        bCgst: item.books?.cgst ?? null,
        bSgst: item.books?.sgst ?? null,
        bTotal: item.books?.total ?? null,
        pTaxable: item.portal?.taxable ?? null,
        pIgst: item.portal?.igst ?? null,
        pCgst: item.portal?.cgst ?? null,
        pSgst: item.portal?.sgst ?? null,
        pTotal: item.portal?.total ?? null,
        diff: item.diff?.tax ?? null,
        risk: item.itcAtRisk || null,
        unclaimed: item.itcUnclaimed || null,
        why: item.why.join(". "),
        bRow: item.books?.row ?? null,
        pRow: item.portal?.row ?? null,
      });
      if (item.docDate) row.getCell(6).numFmt = "dd mmm yyyy";
      for (let col = 7; col <= 19; col += 1) row.getCell(col).numFmt = MONEY;
      row.getCell(20).alignment = { wrapText: true, vertical: "top" };
    }
    sheet.autoFilter = { from: "A1", to: `V${Math.max(items.length + 1, 2)}` };
    return sheet;
  };

  const attention = input.items.filter(item => item.bucket !== "matched" && item.bucket !== "missing_in_books" && item.bucket !== "not_eligible");
  addSheet("Needs action", attention);
  addSheet("In GSTR-2B, not in books", input.items.filter(item => item.bucket === "missing_in_books"));
  addSheet("ITC not available", input.items.filter(item => item.bucket === "not_eligible"));
  addSheet("Matched", input.items.filter(item => item.bucket === "matched"));

  if (input.vendors && input.vendors.length > 0) {
    const vendors = workbook.addWorksheet("Vendor summary");
    vendors.columns = [
      { header: "Supplier GSTIN", width: 20 },
      { header: "Supplier", width: 32 },
      { header: "In books", width: 10 },
      { header: "In GSTR-2B", width: 12 },
      { header: "Matched", width: 10 },
      { header: "Differ / confirm", width: 16 },
      { header: "Not in GSTR-2B", width: 16 },
      { header: "Not in books", width: 14 },
      { header: "Tax in books ₹", width: 16 },
      { header: "Tax in GSTR-2B ₹", width: 17 },
      { header: "ITC at risk ₹", width: 15 },
      { header: "ITC not in books ₹", width: 18 },
    ];
    styleHeader(vendors);
    for (const vendor of input.vendors) {
      const row = vendors.addRow([
        vendor.gstin,
        vendor.name,
        vendor.booksDocs,
        vendor.portalDocs,
        vendor.matched,
        vendor.differing,
        vendor.missingIn2b,
        vendor.missingInBooks,
        vendor.booksTax,
        vendor.portalTax,
        vendor.itcAtRisk,
        vendor.itcUnclaimed,
      ]);
      for (let col = 9; col <= 12; col += 1) row.getCell(col).numFmt = MONEY;
    }
    vendors.autoFilter = { from: "A1", to: `L${input.vendors.length + 1}` };
  }

  const follow = workbook.addWorksheet("Supplier follow-up");
  follow.columns = [
    { header: "Supplier GSTIN", width: 20 },
    { header: "Supplier", width: 30 },
    { header: "Invoices not in GSTR-2B", width: 18 },
    { header: "Amount differs", width: 14 },
    { header: "ITC at risk ₹", width: 16 },
    { header: "Invoices", width: 50 },
    { header: "Message to send", width: 90 },
  ];
  styleHeader(follow);
  for (const supplier of input.suppliers) {
    const row = follow.addRow([
      supplier.gstin,
      supplier.name,
      supplier.missing.length,
      supplier.mismatched,
      supplier.itcAtRisk,
      supplier.missing.map(doc => doc.docNumber).join(", "),
      supplier.missing.length > 0 ? supplierMessage(supplier, input.period, sender) : "",
    ]);
    row.getCell(5).numFmt = MONEY;
    row.getCell(7).alignment = { wrapText: true, vertical: "top" };
    row.getCell(6).alignment = { wrapText: true, vertical: "top" };
  }
  return workbook;
}
