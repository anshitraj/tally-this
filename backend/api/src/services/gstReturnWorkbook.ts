/**
 * Excel working copy of the GSTR-1 tables and the GSTR-3B working.
 * The tab layout follows the tables of the return so a CA can check or key them in. It is not an
 * upload file for the GST portal or the offline tool.
 */
import ExcelJS from "exceljs";
import { stateName } from "./gstStates";
import type { Gstr1Result, Heads } from "./salesRegister";
import type { ItcHeads, ThreeBWorking } from "./gstr3b";

const MONEY = "#,##0.00;[Red](#,##0.00)";
const rupees = (paise: number) => paise / 100;

function pos(code: string) {
  return code ? `${code}-${stateName(code) ?? ""}`.replace(/-$/, "") : "";
}

function addTable(sheet: ExcelJS.Worksheet, title: string, headers: string[], rows: Array<Array<string | number | null>>, moneyColumns: number[]) {
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { bold: true, size: 13 };
  const header = sheet.getRow(3);
  header.values = headers;
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: "middle" };
  rows.forEach((values, index) => {
    const row = sheet.getRow(4 + index);
    row.values = values;
    for (const column of moneyColumns) row.getCell(column).numFmt = MONEY;
  });
  headers.forEach((_, index) => {
    sheet.getColumn(index + 1).width = index === 0 ? 24 : Math.max(14, Math.min(34, headers[index].length + 4));
  });
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  if (rows.length === 0) sheet.getCell("A4").value = "Nothing in this table.";
}

export interface ReturnWorkbookInput {
  clientName: string;
  gstr1: Gstr1Result;
  threeB: ThreeBWorking | null;
}

function invoiceRows(rows: Gstr1Result["b2b"]) {
  return rows.flatMap(row =>
    row.rates.map((rate, index) => [
      row.gstin,
      row.customer,
      row.number,
      row.date,
      index === 0 ? rupees(row.value) : null,
      pos(row.pos),
      row.reverseCharge ? "Y" : "N",
      rate.rate,
      rupees(rate.taxable),
      rupees(rate.igst),
      rupees(rate.cgst),
      rupees(rate.sgst),
      rupees(rate.cess),
      row.flags.join(" "),
    ]),
  );
}

const INVOICE_HEADERS = ["GSTIN/UIN of recipient", "Receiver name", "Invoice number", "Invoice date", "Invoice value", "Place of supply", "Reverse charge", "Rate %", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Check"];
const NOTE_HEADERS = ["GSTIN/UIN of recipient", "Receiver name", "Note type", "Note number", "Note date", "Original invoice", "Note value", "Place of supply", "Rate %", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Check"];

function noteRows(rows: Gstr1Result["cdnr"]) {
  return rows.flatMap(row =>
    row.rates.map((rate, index) => [
      row.gstin,
      row.customer,
      row.type === "C" ? "Credit note" : "Debit note",
      row.number,
      row.date,
      row.originalInvoice,
      index === 0 ? rupees(row.value) : null,
      pos(row.pos),
      rate.rate,
      rupees(rate.taxable),
      rupees(rate.igst),
      rupees(rate.cgst),
      rupees(rate.sgst),
      rupees(rate.cess),
      row.flags.join(" "),
    ]),
  );
}

function headsRow(label: string, heads: Heads | ItcHeads & { taxable?: number }): Array<string | number> {
  return [label, rupees((heads as Heads).taxable ?? 0), rupees(heads.igst), rupees(heads.cgst), rupees(heads.sgst), rupees(heads.cess)];
}

export function buildReturnWorkbook(input: ReturnWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TallyThis";
  const { gstr1, threeB } = input;

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 38 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 50 }];
  summary.getCell("A1").value = `${input.clientName} · GSTR-1 working${gstr1.period ? ` for ${gstr1.period}` : ""}`;
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = "A working copy for CA review. It is not a return and has not been checked by the GST portal.";
  summary.getRow(4).values = ["Table", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Documents"];
  summary.getRow(4).font = { bold: true };
  const tables: Array<[string, Heads, number]> = [
    ["4A/4B  B2B invoices", gstr1.totals.b2b, gstr1.b2b.length],
    ["5  B2C Large", gstr1.totals.b2cl, gstr1.b2cl.length],
    ["7  B2C Small (state and rate)", gstr1.totals.b2cs, gstr1.b2cs.length],
    ["9B  Credit/debit notes, registered", gstr1.totals.cdnr, gstr1.cdnr.length],
    ["9B  Credit/debit notes, unregistered", gstr1.totals.cdnur, gstr1.cdnur.length],
    ["6A  Exports and SEZ (needs completing)", gstr1.totals.exp, gstr1.exports.length],
    ["8  Nil-rated, exempt or non-GST", gstr1.totals.nil, gstr1.nil.reduce((sum, row) => sum + row.documents, 0)],
    ["Not placed (needs review)", gstr1.totals.review, gstr1.review.length],
  ];
  tables.forEach(([label, heads, count], index) => {
    const row = summary.getRow(5 + index);
    row.values = [label, rupees(heads.taxable), rupees(heads.igst), rupees(heads.cgst), rupees(heads.sgst), rupees(heads.cess), count];
    for (let column = 2; column <= 6; column += 1) row.getCell(column).numFmt = MONEY;
  });
  const totalRow = summary.getRow(5 + tables.length);
  totalRow.values = ["All tables, net of credit notes", rupees(gstr1.totals.all.taxable), rupees(gstr1.totals.all.igst), rupees(gstr1.totals.all.cgst), rupees(gstr1.totals.all.sgst), rupees(gstr1.totals.all.cess)];
  totalRow.font = { bold: true };
  const registerRow = summary.getRow(6 + tables.length);
  registerRow.values = ["Sales register, added directly", rupees(gstr1.register.taxable), rupees(gstr1.register.igst), rupees(gstr1.register.cgst), rupees(gstr1.register.sgst), rupees(gstr1.register.cess)];
  const diff = summary.getRow(7 + tables.length);
  const balanced = Object.values(gstr1.difference).every(value => value === 0);
  diff.values = ["Difference", rupees(gstr1.difference.taxable), rupees(gstr1.difference.igst), rupees(gstr1.difference.cgst), rupees(gstr1.difference.sgst), rupees(gstr1.difference.cess), balanced ? "The tables agree with the register." : "The tables do not agree with the register. Do not use this file."];
  for (const row of [totalRow, registerRow, diff]) for (let column = 2; column <= 6; column += 1) row.getCell(column).numFmt = MONEY;
  let noteRow = 9 + tables.length;
  for (const note of gstr1.notes) summary.getCell(noteRow++, 1).value = note;

  addTable(workbook.addWorksheet("B2B"), "B2B invoices (Table 4)", INVOICE_HEADERS, invoiceRows(gstr1.b2b), [5, 9, 10, 11, 12, 13]);
  addTable(workbook.addWorksheet("B2C Large"), "B2C Large (Table 5)", INVOICE_HEADERS, invoiceRows(gstr1.b2cl), [5, 9, 10, 11, 12, 13]);
  addTable(
    workbook.addWorksheet("B2C Small"),
    "B2C Small (Table 7), by state and rate",
    ["Place of supply", "Rate %", "Taxable value", "IGST", "CGST", "SGST", "Cess"],
    gstr1.b2cs.map(row => [pos(row.pos), row.rate, rupees(row.taxable), rupees(row.igst), rupees(row.cgst), rupees(row.sgst), rupees(row.cess)]),
    [3, 4, 5, 6, 7],
  );
  addTable(workbook.addWorksheet("Notes registered"), "Credit and debit notes to registered buyers (Table 9B)", NOTE_HEADERS, noteRows(gstr1.cdnr), [7, 10, 11, 12, 13, 14]);
  addTable(workbook.addWorksheet("Notes unregistered"), "Credit and debit notes to unregistered buyers (Table 9B)", NOTE_HEADERS, noteRows(gstr1.cdnur), [7, 10, 11, 12, 13, 14]);
  addTable(workbook.addWorksheet("Exports and SEZ"), "Exports and SEZ supplies. Shipping bill and port details are not in the register.", INVOICE_HEADERS, invoiceRows(gstr1.exports), [5, 9, 10, 11, 12, 13]);
  addTable(
    workbook.addWorksheet("Nil exempt"),
    "Nil-rated, exempted and non-GST supplies (Table 8). The register does not say which of the three; split before filing.",
    ["Nature of supply", "To registered buyers", "Taxable value", "Documents"],
    gstr1.nil.map(row => [row.nature, row.registered ? "Yes" : "No", rupees(row.taxable), row.documents]),
    [3],
  );
  const hsnHeaders = ["HSN/SAC", "UQC", "Quantity", "Total value", "Rate %", "Taxable value", "IGST", "CGST", "SGST", "Cess"];
  const hsnRows = (rows: Gstr1Result["hsnB2b"]) => rows.map(row => [row.hsn, row.uqc, row.qty, rupees(row.value), row.rate, rupees(row.taxable), rupees(row.igst), rupees(row.cgst), rupees(row.sgst), rupees(row.cess)]);
  addTable(workbook.addWorksheet("HSN B2B"), "HSN summary, supplies to registered buyers (Table 12)", hsnHeaders, hsnRows(gstr1.hsnB2b), [4, 6, 7, 8, 9, 10]);
  addTable(workbook.addWorksheet("HSN B2C"), "HSN summary, supplies to unregistered buyers (Table 12)", hsnHeaders, hsnRows(gstr1.hsnB2c), [4, 6, 7, 8, 9, 10]);
  addTable(
    workbook.addWorksheet("Documents"),
    "Documents issued (Table 13)",
    ["Nature of document", "Series", "From", "To", "Total number", "Cancelled", "Net issued", "Numbers missing from the series"],
    gstr1.documents.map(row => [row.kind, row.prefix, row.from, row.to, row.total, row.cancelled, row.net, row.missing.join(", ")]),
    [],
  );
  addTable(
    workbook.addWorksheet("Needs review"),
    "Documents with something to check",
    ["Invoice number", "Customer", "Date", "Placed in", "What to check"],
    gstr1.flagged.map(row => [row.number, row.customer, row.date, row.section.toUpperCase(), row.flags.join(" ")]),
    [],
  );

  if (threeB) {
    const sheet = workbook.addWorksheet("GSTR-3B working");
    sheet.columns = [{ width: 52 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }];
    sheet.getCell("A1").value = `${input.clientName} · GSTR-3B working${threeB.period ? ` for ${threeB.period}` : ""}`;
    sheet.getCell("A1").font = { bold: true, size: 14 };
    sheet.getCell("A2").value = "A working for CA review. Credit, reversals and payment are the CA's decision.";
    sheet.getRow(4).values = ["Table 3.1 Outward supplies", "Taxable value", "IGST", "CGST", "SGST", "Cess"];
    sheet.getRow(4).font = { bold: true };
    const lines: Array<Array<string | number>> = [
      headsRow("(a) Outward taxable supplies (other than zero-rated, nil-rated, exempted)", threeB.outward),
      headsRow("(b) Outward taxable supplies (zero-rated)", threeB.zeroRated),
      ["(c) Other outward supplies (nil-rated, exempted)", rupees(threeB.nilExempt), 0, 0, 0, 0],
      headsRow("(d) Inward supplies liable to reverse charge (entered by CA)", threeB.rcm),
    ];
    lines.forEach((values, index) => {
      sheet.getRow(5 + index).values = values;
      for (let column = 2; column <= 6; column += 1) sheet.getRow(5 + index).getCell(column).numFmt = MONEY;
    });
    let at = 5 + lines.length + 1;
    sheet.getRow(at).values = ["Table 3.2 Inter-state supplies to unregistered persons", "Taxable value", "IGST"];
    sheet.getRow(at).font = { bold: true };
    at += 1;
    for (const row of threeB.interStateUnregistered) {
      sheet.getRow(at).values = [pos(row.pos), rupees(row.taxable), rupees(row.igst)];
      sheet.getRow(at).getCell(2).numFmt = MONEY;
      sheet.getRow(at).getCell(3).numFmt = MONEY;
      at += 1;
    }
    at += 1;
    sheet.getRow(at).values = [`Table 4 Input tax credit (basis: ${threeB.basis === "matched" ? "matched with books" : "as per GSTR-2B"})`, "", "IGST", "CGST", "SGST", "Cess"];
    sheet.getRow(at).font = { bold: true };
    at += 1;
    const itcLines: Array<[string, ItcHeads]> = [
      ["(A) ITC available", threeB.itc.available],
      ["(B) ITC reversed (entered by CA)", threeB.itc.reversal],
      ["Additional credit (entered by CA)", threeB.itc.additional],
      ["(C) Net ITC available", threeB.itc.net],
      ["(D) ITC not available per GSTR-2B", threeB.itc.notEligible],
      ["In books but not in GSTR-2B (not claimed here)", threeB.itc.atRisk],
    ];
    for (const [label, heads] of itcLines) {
      sheet.getRow(at).values = [label, "", rupees(heads.igst), rupees(heads.cgst), rupees(heads.sgst), rupees(heads.cess)];
      for (let column = 3; column <= 6; column += 1) sheet.getRow(at).getCell(column).numFmt = MONEY;
      at += 1;
    }
    at += 1;
    sheet.getRow(at).values = ["Table 6.1 Payment of tax", "", "IGST", "CGST", "SGST", "Cess"];
    sheet.getRow(at).font = { bold: true };
    at += 1;
    const pay = threeB.payment;
    const payLines: Array<[string, ItcHeads]> = [
      ["Tax payable", pay.liability],
      ["Paid through ITC: IGST credit", { igst: pay.setOff.igstToIgst, cgst: pay.setOff.igstToCgst, sgst: pay.setOff.igstToSgst, cess: 0 }],
      ["Paid through ITC: CGST credit", { igst: pay.setOff.cgstToIgst, cgst: pay.setOff.cgstToCgst, sgst: 0, cess: 0 }],
      ["Paid through ITC: SGST credit", { igst: pay.setOff.sgstToIgst, cgst: 0, sgst: pay.setOff.sgstToSgst, cess: 0 }],
      ["Paid through ITC: cess credit", { igst: 0, cgst: 0, sgst: 0, cess: pay.setOff.cessToCess }],
      ["Tax payable in cash", pay.cash],
      ["Reverse-charge tax payable in cash", threeB.rcmCash],
      ["Credit carried forward", pay.carryForward],
    ];
    for (const [label, heads] of payLines) {
      sheet.getRow(at).values = [label, "", rupees(heads.igst), rupees(heads.cgst), rupees(heads.sgst), rupees(heads.cess)];
      for (let column = 3; column <= 6; column += 1) sheet.getRow(at).getCell(column).numFmt = MONEY;
      at += 1;
    }
    at += 1;
    for (const warning of threeB.warnings) sheet.getCell(at++, 1).value = warning;
    if (threeB.itc.source?.period) sheet.getCell(at, 1).value = `Credit taken from the GSTR-2B ↔ Books result for ${threeB.itc.source.period}.`;
  }
  return workbook;
}
