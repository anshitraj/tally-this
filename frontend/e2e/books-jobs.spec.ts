import { test, expect, type Page } from "@playwright/test";
import { signedIn } from "./signedIn";

// Browser-only fixtures: every API reply below is made up here. No real books, files or accounts are used.

const heads = (taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0) => ({ taxable, igst, cgst, sgst, cess });
const file = (name: string, text = "x") => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });

function bill(over: Record<string, unknown>) {
  return {
    key: "b1",
    source: "sheet",
    fileName: "bills.xlsx",
    row: 2,
    supplierName: "Alpha Traders",
    supplierGstin: "27AAPFU0939F1ZV",
    invoiceNumber: "INV-001",
    invoiceDate: "2026-10-05",
    placeOfSupply: null,
    taxable: 10000,
    igst: 0,
    cgst: 900,
    sgst: 900,
    cess: 0,
    total: 11800,
    reverseCharge: false,
    include: true,
    gstinValid: true,
    roundOff: 0,
    issues: [],
    blocked: false,
    duplicateOf: null,
    supplierState: "27",
    ...over,
  };
}

async function openJob(page: Page, path: string) {
  await signedIn(page);
  await page.goto(path);
}

test("Bills → Tally holds the Tally file back until a bad bill is fixed, then downloads it", async ({ page }) => {
  const good = bill({});
  const bad = bill({ key: "b2", supplierName: "Wrong Total Co", invoiceNumber: "WT-1", total: 1500, taxable: 1000, cgst: 0, sgst: 0, igst: 180, blocked: true, issues: [{ level: "block", code: "total_mismatch", message: "Taxable value plus tax is 1180.00 but the invoice total is 1500.00." }] });
  await openJob(page, "/app/jobs/bills-tally");
  await page.route("**/api/jobs/bills/read", route => route.fulfill({ json: { ok: true, runId: "run-1", bills: [good, bad], counts: { sheet: 2 }, notes: [], unreadable: [], recipientGstin: null } }));
  await page.route("**/api/jobs/bills/check", route => {
    const posted = route.request().postDataJSON() as { bills: Array<Record<string, unknown>> };
    // The server recalculates; the fixture answers with the bill left out and nothing blocked.
    route.fulfill({ json: { ok: true, bills: posted.bills.map(item => ({ ...item, blocked: false, issues: [] })) } });
  });
  await page.route("**/api/jobs/bills/xml", route => route.fulfill({ json: { ok: true, xml: "<ENVELOPE/>", fileName: "demo-purchase-vouchers.xml", voucherCount: 1, vouchers: [], message: "Tally file is ready. 1 purchase voucher checked and balanced." } }));

  await page.locator("input[type=file]").first().setInputFiles(file("bills.xlsx"));
  await expect(page.getByText("ready for Tally")).toBeVisible();
  // One bill is blocked, so the primary action is to fix it and there is no Tally download yet.
  await expect(page.getByRole("button", { name: "Fix 1 bill" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Tally File" })).toHaveCount(0);

  await page.getByRole("button", { name: "Fix 1 bill" }).click();
  await expect(page.getByText("Taxable value plus tax is 1180.00")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await page.getByLabel("Leave this bill out").check();
  await page.getByRole("button", { name: "Save and check again" }).click();

  const downloadButton = page.getByRole("button", { name: "Download Tally File" });
  await expect(downloadButton).toBeVisible();
  const download = page.waitForEvent("download");
  await downloadButton.click();
  expect((await download).suggestedFilename()).toBe("demo-purchase-vouchers.xml");
});

test("Bills → Tally shows what could not be read and asks before using AI", async ({ page }) => {
  await openJob(page, "/app/jobs/bills-tally");
  let asked = 0;
  await page.route("**/api/jobs/bills/read", route => {
    asked += 1;
    if (asked === 1) route.fulfill({ status: 422, json: { ok: false, needsAiConsent: true, message: "Incognito reads a scan with AI only after you agree." } });
    else route.fulfill({ json: { ok: true, runId: null, privacy: false, bills: [bill({ source: "ai" })], counts: { ai: 1 }, notes: [], unreadable: [{ fileName: "photo2.jpg", reason: "No invoice could be read from this file." }], recipientGstin: null } });
  });
  await page.locator("input[type=file]").first().setInputFiles(file("scan.jpg"));
  await expect(page.getByText("Incognito reads a scan with AI only after you agree.")).toBeVisible();
  await page.getByRole("button", { name: "Read this file with AI" }).click();
  await expect(page.getByText("ready for Tally")).toBeVisible();
  await expect(page.getByText("photo2.jpg")).toBeVisible();
});

test("Sales → GSTR-1 & 3B shows the tables, flags what needs a look, and updates the 3B when credit is chosen", async ({ page }) => {
  const gstr1 = {
    period: "2026-10",
    periods: ["2026-10"],
    sellerGstin: "27AAPFU0939F1ZV",
    b2clLimitRupees: 100000,
    b2b: [{}],
    b2cl: [],
    b2cs: [{}],
    cdnr: [],
    cdnur: [],
    exports: [],
    nil: [],
    review: [],
    hsnMissing: 0,
    totals: {
      b2b: heads(10000000, 1800000), b2cl: heads(), b2cs: heads(500000, 0, 45000, 45000), cdnr: heads(), cdnur: heads(), exp: heads(), nil: heads(), review: heads(),
      all: heads(10500000, 1800000, 45000, 45000),
    },
    register: heads(10500000, 1800000, 45000, 45000),
    difference: heads(),
    flagged: [{ id: "d1", number: "S-004", customer: "Delhi Walk-in", date: "2026-10-05", section: "b2cs", flags: ["Place of supply is missing for an inter-state sale."] }],
    notes: ["B2C Large limit used: ₹1,00,000 per inter-state invoice. Check it against the current notification."],
    counts: { documents: 2, invoices: 2, notes: 0, cancelled: 0 },
    documents: [],
  };
  const threeB = (cash: number, warnings: string[]) => ({
    period: "2026-10", basis: "matched",
    outward: heads(10500000, 1800000, 45000, 45000), zeroRated: heads(), nilExempt: 0, rcm: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }, interStateUnregistered: [],
    itc: { source: null, available: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, reversal: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, additional: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, net: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, notEligible: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, atRisk: { igst: 0, cgst: 0, sgst: 0, cess: 0 } },
    payment: { liability: { igst: 1800000, cgst: 45000, sgst: 45000, cess: 0 }, credit: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, cash: { igst: cash, cgst: 45000, sgst: 45000, cess: 0 }, carryForward: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, setOff: {} },
    rcmCash: { igst: 0, cgst: 0, sgst: 0, cess: 0 }, warnings,
  });
  await openJob(page, "/app/jobs/gst-sales");
  await page.route("**/api/jobs/gst-sales/read", route => route.fulfill({ json: { ok: true, runId: "run-2", file: "register.xlsx", gstr1, threeB: threeB(1800000, ["No GSTR-2B ↔ Books result was found for this client, so input tax credit is shown as nil."]), itcRuns: [{ runId: "run-2b", title: "GSTR-2B ↔ Books — oct.json", createdAt: "2026-10-12", period: "2026-10" }], itcRunId: null } }));
  let requested: Record<string, unknown> | null = null;
  await page.route("**/api/jobs/gst-sales/3b", route => {
    requested = route.request().postDataJSON() as Record<string, unknown>;
    route.fulfill({ json: { ok: true, threeB: threeB(300000, []) } });
  });
  await page.route("**/api/jobs/gst-sales/excel", route => route.fulfill({ body: Buffer.from("xlsx"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

  await page.locator("input[type=file]").first().setInputFiles(file("register.xlsx"));
  await expect(page.getByText("sorted into tables")).toBeVisible();
  await expect(page.getByText("Sales to registered buyers (B2B)")).toBeVisible();
  await page.getByRole("button", { name: "Review 1 item" }).click();
  await expect(page.getByText("Place of supply is missing for an inter-state sale.")).toBeVisible();

  await page.getByRole("button", { name: "GSTR-3B working" }).click();
  await expect(page.getByText("No GSTR-2B ↔ Books result was found for this client")).toBeVisible();
  await page.getByLabel("GSTR-2B ↔ Books result").selectOption("run-2b");
  await expect.poll(() => requested?.itcRunId).toBe("run-2b");
  await expect(page.getByText("No GSTR-2B ↔ Books result was found for this client")).toHaveCount(0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GSTR-1 & 3B working" }).click();
  expect((await download).suggestedFilename()).toBe("TallyThis_GSTR1_3B_Working.xlsx");
});

test("Payroll shows the employer, the checks and the statutory working, and downloads the Tally entry", async ({ page }) => {
  const employee = (row: number, name: string, net: number, flags: string[] = []) => ({
    row, code: `E00${row}`, name, designation: "", uan: "", esicNumber: "", pan: "", account: "", ifsc: "", paidDays: 31, basic: 2000000, pfWage: 2000000,
    earnings: [{ head: "Basic", amount: 2000000 }], gross: 3500000, pf: 180000, esi: 0, pt: 20000, tds: 100000, otherDeductions: [], deductions: 300000, net, employerPf: null, employerEsi: null, flags, blocked: false,
  });
  await openJob(page, "/app/jobs/payroll");
  await page.route("**/api/jobs/payroll/read", route => route.fulfill({
    json: {
      ok: true, runId: "run-3", file: "salary.xlsx", employer: { name: "Sunrise Traders Pvt Ltd", pan: "ABCDE1234F" }, month: "2026-10",
      employees: [employee(1, "Anita Rao", 3200000), employee(2, "Meena Joshi", 3200000, ["PF is deducted but there is no UAN. The PF return needs it."])],
      statutory: {
        employees: 2, gross: 7000000, net: 6400000,
        pf: { wages: 4000000, employee: 360000, employer: 360000, employerComputed: true, pension: 250000, employerPf: 110000, adminCharges: 50000, edli: 15000, challan: 785000 },
        esi: { wages: 0, employee: 0, employer: 0, employerComputed: false, challan: 0, covered: 0 }, pt: 40000, tds: 200000, otherDeductions: 0,
      },
      bank: null, bankMessage: "", notes: [],
    },
  }));
  await page.route("**/api/jobs/payroll/journal", route => route.fulfill({ json: { ok: true, xml: "<ENVELOPE/>", fileName: "sunrise-traders-salary-journal-2026-10.xml", lines: [], message: "Salary journal for Tally is ready. It balances to the paise." } }));

  await page.locator("input[type=file]").first().setInputFiles(file("salary.xlsx"));
  await expect(page.getByText("Sunrise Traders Pvt Ltd · October 2026")).toBeVisible();
  await expect(page.getByText("PF is deducted but there is no UAN.").last()).toBeVisible();

  await page.getByRole("button", { name: "PF, ESI and TDS" }).click();
  await expect(page.getByText("Computed as equal to the employee share")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Salary entry for Tally" }).click();
  expect((await download).suggestedFilename()).toBe("sunrise-traders-salary-journal-2026-10.xml");
});

test("the three new jobs are listed on Home and in the menu, and the old payroll address opens the job", async ({ page }) => {
  await signedIn(page);
  await page.goto("/app/overview");
  for (const name of ["Bills → Tally", "Sales → GSTR-1 & 3B", "Payroll"]) {
    await expect(page.getByRole("button", { name }).first()).toBeVisible();
  }
  await page.goto("/app/payroll");
  await expect(page).toHaveURL(/\/app\/jobs\/payroll/);
  await expect(page.getByRole("heading", { level: 1, name: "Payroll" })).toBeVisible();
});
