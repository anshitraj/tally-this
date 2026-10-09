import { db } from "@workspace/db";
import {
  auditLogsTable,
  authSessionsTable,
  uploadBatchesTable,
  bankTransactionsTable,
  companiesTable,
  documentsTable,
  gstRecordsTable,
  invoicesTable,
  ledgerEntriesTable,
  oauthAccountsTable,
  payrollEntriesTable,
  gatewaySettlementsTable,
  reconciliationMatchesTable,
  riskFlagsTable,
  caReviewItemsTable,
  rolePermissionsTable,
  usersTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { hashPassword } from "../services/auth";

const DEMO_COMPANY_NAME = "NovaStack Labs Pvt Ltd";

export async function seedDemoData() {
  const existingDemoCompanies = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(inArray(companiesTable.name, [DEMO_COMPANY_NAME]));
  const demoCompanyIds = existingDemoCompanies.map((company) => company.id);

  if (demoCompanyIds.length > 0) {
    await db.delete(authSessionsTable).where(inArray(authSessionsTable.companyId, demoCompanyIds));
    await db.delete(oauthAccountsTable).where(inArray(oauthAccountsTable.companyId, demoCompanyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, demoCompanyIds));
    await db.delete(gstRecordsTable).where(inArray(gstRecordsTable.companyId, demoCompanyIds));
    await db.delete(documentsTable).where(inArray(documentsTable.companyId, demoCompanyIds));
    await db.delete(rolePermissionsTable).where(inArray(rolePermissionsTable.companyId, demoCompanyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, demoCompanyIds));
    await db.delete(caReviewItemsTable).where(inArray(caReviewItemsTable.companyId, demoCompanyIds));
    await db.delete(reconciliationMatchesTable).where(inArray(reconciliationMatchesTable.companyId, demoCompanyIds));
    await db.delete(riskFlagsTable).where(inArray(riskFlagsTable.companyId, demoCompanyIds));
    await db.delete(gatewaySettlementsTable).where(inArray(gatewaySettlementsTable.companyId, demoCompanyIds));
    await db.delete(payrollEntriesTable).where(inArray(payrollEntriesTable.companyId, demoCompanyIds));
    await db.delete(ledgerEntriesTable).where(inArray(ledgerEntriesTable.companyId, demoCompanyIds));
    await db.delete(invoicesTable).where(inArray(invoicesTable.companyId, demoCompanyIds));
    await db.delete(bankTransactionsTable).where(inArray(bankTransactionsTable.companyId, demoCompanyIds));
    await db.delete(uploadBatchesTable).where(inArray(uploadBatchesTable.companyId, demoCompanyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, demoCompanyIds));
  }

  const [company] = await db.insert(companiesTable).values({
    name: DEMO_COMPANY_NAME,
    industry: "SaaS + marketing agency",
    monthlyRevenueRange: "₹42L",
    caEmail: "ca@finverify.in",
    gstin: "29AAHCN0094Q1ZF",
    pan: "AAHCN0094Q",
    financialYearStart: "April",
    plan: "growth", // the sample workspace shows paid features such as privacy mode
    currency: "INR",
    dataRetentionDays: 365,
  }).returning();

  const demoPassword = hashPassword("demo1234");
  const users = await db.insert(usersTable).values([
    {
      companyId: company.id,
      name: "Rahul Mehta",
      email: "rahul@novastack.in",
      passwordHash: demoPassword.hash,
      passwordSalt: demoPassword.salt,
      role: "founder",
      status: "active",
    },
    {
      companyId: company.id,
      name: "CA Priya Sharma",
      email: "ca@finverify.in",
      passwordHash: demoPassword.hash,
      passwordSalt: demoPassword.salt,
      role: "ca",
      status: "active",
    },
    {
      companyId: company.id,
      name: "Ananya Rao",
      email: "finance@novastack.in",
      passwordHash: demoPassword.hash,
      passwordSalt: demoPassword.salt,
      role: "admin",
      status: "active",
    },
  ]).returning();

  await db.insert(rolePermissionsTable).values([
    { companyId: company.id, role: "founder", permission: "overview.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "transactions.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "invoices.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "ledger.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "risks.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "payroll.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "gateway.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "reports.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "reconciliation.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "reconciliation.run", enabled: true },
    { companyId: company.id, role: "founder", permission: "reconciliation.approve", enabled: true },
    { companyId: company.id, role: "founder", permission: "reconciliation.reject", enabled: true },
    { companyId: company.id, role: "founder", permission: "uploads.read", enabled: true },
    { companyId: company.id, role: "founder", permission: "uploads.create", enabled: true },
    { companyId: company.id, role: "founder", permission: "uploads.delete", enabled: true },
    { companyId: company.id, role: "founder", permission: "reports.export", enabled: true },
    { companyId: company.id, role: "founder", permission: "settings.manage_company", enabled: true },
    { companyId: company.id, role: "founder", permission: "ai.assist", enabled: true },
    { companyId: company.id, role: "admin", permission: "overview.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "transactions.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "invoices.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "ledger.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "risks.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "payroll.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "gateway.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "reports.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "reconciliation.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "uploads.read", enabled: true },
    { companyId: company.id, role: "admin", permission: "uploads.create", enabled: true },
    { companyId: company.id, role: "admin", permission: "uploads.delete", enabled: true },
    { companyId: company.id, role: "admin", permission: "invoices.create", enabled: true },
    { companyId: company.id, role: "admin", permission: "transactions.update_status", enabled: true },
    { companyId: company.id, role: "admin", permission: "reconciliation.run", enabled: true },
    { companyId: company.id, role: "admin", permission: "reconciliation.approve", enabled: true },
    { companyId: company.id, role: "admin", permission: "reconciliation.reject", enabled: true },
    { companyId: company.id, role: "admin", permission: "ai.assist", enabled: true },
    { companyId: company.id, role: "ca", permission: "overview.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "transactions.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "invoices.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "ledger.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "risks.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "payroll.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "gateway.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "reports.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "reconciliation.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "reconciliation.approve", enabled: true },
    { companyId: company.id, role: "ca", permission: "reconciliation.reject", enabled: true },
    { companyId: company.id, role: "ca", permission: "uploads.read", enabled: true },
    { companyId: company.id, role: "ca", permission: "ca_review.process", enabled: true },
    { companyId: company.id, role: "ca", permission: "risks.resolve", enabled: true },
    { companyId: company.id, role: "ca", permission: "ai.assist", enabled: true },
    { companyId: company.id, role: "ca", permission: "settings.manage_company", enabled: false },
  ]);

  // Upload batches
  const uploads = await db.insert(uploadBatchesTable).values([
    { companyId: company.id, sourceType: "bank", fileName: "HDFC_May2026.csv", status: "processed", recordCount: 60 },
    { companyId: company.id, sourceType: "invoices", fileName: "Invoices_May2026.pdf", status: "processed", recordCount: 30 },
    { companyId: company.id, sourceType: "tally", fileName: "Tally_Ledger_May2026.xml", status: "processed", recordCount: 20 },
    { companyId: company.id, sourceType: "payroll", fileName: "Payroll_May2026.xlsx", status: "processed", recordCount: 10 },
    { companyId: company.id, sourceType: "gateway", fileName: "Razorpay_Settlements_May2026.csv", status: "processed", recordCount: 12 },
    { companyId: company.id, sourceType: "gst", fileName: "GSTR2B_May2026.json", status: "partial", recordCount: 15 },
  ]).returning();

  await db.insert(documentsTable).values(uploads.map(upload => ({
    companyId: company.id,
    uploadBatchId: upload.id,
    fileName: upload.fileName,
    sourceType: upload.sourceType,
    storageProvider: "metadata_only",
    status: "metadata_captured",
    extractedTextStatus: upload.sourceType === "invoices" ? "placeholder" : "not_required",
    rowCount: upload.recordCount ?? null,
    detectedColumns: upload.sourceType === "bank"
      ? ["date", "narration", "amount", "type", "reference"]
      : upload.sourceType === "gateway"
      ? ["settlement_id", "gross_amount", "fees", "gst_on_fees", "net_amount"]
      : [],
    uploadedByUserId: users[2].id,
  })));

  // Bank Transactions (60 entries)
  const txns = await db.insert(bankTransactionsTable).values([
    { date: "2026-05-01", narration: "UPI/NEFT-INV-2026-001/Zomato Media Ltd/HDFC0001234", amount: "285000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "UTR1234567890", status: "verified", confidenceScore: 92 },
    { date: "2026-05-01", narration: "NEFT-Swiggy Technologies/Vendor Payment/ICIC0001", amount: "47500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260501001", status: "verified", confidenceScore: 88 },
    { date: "2026-05-02", narration: "UPI-Amazon Pay/AWS Services INV-AWS-2026-045", amount: "156200.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UTR9876543210", status: "verified", confidenceScore: 95 },
    { date: "2026-05-02", narration: "RTGS-Accenture Solutions Pvt Ltd/Project Milestone", amount: "620000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026050201", status: "verified", confidenceScore: 91 },
    { date: "2026-05-03", narration: "IMPS-Rent May 2026/Industrial Estate Properties", amount: "85000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "IMPS2026050301", status: "verified", confidenceScore: 97 },
    { date: "2026-05-03", narration: "UPI-Razorpay Settlement/May Batch 1/RZP-STL-2345", amount: "312450.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "RZP2345STL", status: "verified", confidenceScore: 93 },
    { date: "2026-05-04", narration: "NEFT-TCS Ltd/Consulting Fees INV-TCS-001", amount: "225000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260504001", status: "verified", confidenceScore: 89 },
    { date: "2026-05-04", narration: "UPI-Flipkart Commerce/Platform Revenue May", amount: "189000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "UTR5544332211", status: "unverified", confidenceScore: 55 },
    { date: "2026-05-05", narration: "NEFT-Notion Labs/Workspace subscription INV-NOT-789", amount: "24500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260505001", status: "verified", confidenceScore: 94 },
    { date: "2026-05-05", narration: "UPI-Unknown Vendor/Payment no reference", amount: "32000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260505", status: "missing_invoice", confidenceScore: 18 },
    { date: "2026-05-06", narration: "RTGS-Infosys BPM Ltd/Digital Transformation Phase 2", amount: "800000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026050601", status: "verified", confidenceScore: 96 },
    { date: "2026-05-06", narration: "NEFT-Slack Technologies/Team plan renewal", amount: "18200.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260506001", status: "verified", confidenceScore: 90 },
    { date: "2026-05-07", narration: "IMPS-Cash withdrawal ATM Koramangala", amount: "20000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "ATM2026050701", status: "gst_risk", confidenceScore: 30 },
    { date: "2026-05-07", narration: "UPI-Meesho Supplier Network/Payout batch", amount: "95500.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "UTR6677889900", status: "unverified", confidenceScore: 52 },
    { date: "2026-05-08", narration: "NEFT-Google India/Ads INV-GADS-2026-091", amount: "67800.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260508001", status: "verified", confidenceScore: 93 },
    { date: "2026-05-08", narration: "RTGS-Myntra Designs/Vendor payment", amount: "245000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026050801", status: "verified", confidenceScore: 88 },
    { date: "2026-05-09", narration: "UPI-Cashfree Settlement/Payout batch CF-2026-0509", amount: "187230.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "CF2026050901", status: "verified", confidenceScore: 95 },
    { date: "2026-05-09", narration: "NEFT-HubSpot India/CRM license INV-HUB-2026-34", amount: "45600.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260509001", status: "verified", confidenceScore: 91 },
    { date: "2026-05-10", narration: "IMPS-Salary May 2026/Batch transfer EMP-001 to 010", amount: "580000.00", type: "debit", source: "payroll", bankName: "HDFC Bank", reference: "SAL20260510001", status: "verified", confidenceScore: 98 },
    { date: "2026-05-10", narration: "UPI-Bigbasket Commerce/Bulk purchase no invoice", amount: "28400.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260510002", status: "missing_invoice", confidenceScore: 22 },
    { date: "2026-05-11", narration: "NEFT-Wipro Ltd/IT support contract", amount: "340000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260511001", status: "unverified", confidenceScore: 48 },
    { date: "2026-05-11", narration: "UPI-Freshworks/Support license INV-FW-2026-128", amount: "32100.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UTR1122334455", status: "verified", confidenceScore: 92 },
    { date: "2026-05-12", narration: "RTGS-Zepto Tech/Q1 payment partial", amount: "150000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026051201", status: "amount_mismatch", confidenceScore: 61 },
    { date: "2026-05-12", narration: "NEFT-Microsoft India/Azure INV-MS-2026-567", amount: "89450.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260512001", status: "verified", confidenceScore: 96 },
    { date: "2026-05-13", narration: "UPI-Dunzo Daily/Procurement vendor", amount: "15200.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260513001", status: "missing_invoice", confidenceScore: 15 },
    { date: "2026-05-13", narration: "IMPS-Shiprocket/Logistics fee INV-SR-2026-445", amount: "23400.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "IMPS2026051301", status: "verified", confidenceScore: 90 },
    { date: "2026-05-14", narration: "NEFT-Ola Electric/Vendor advance payment", amount: "75000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260514001", status: "tds_risk", confidenceScore: 42 },
    { date: "2026-05-14", narration: "UPI-Razorpay Settlement/May Batch 2/RZP-STL-2346", amount: "198760.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "RZP2346STL", status: "verified", confidenceScore: 94 },
    { date: "2026-05-15", narration: "NEFT-Zoho Corp/Suite license INV-ZOHO-2026-99", amount: "41200.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260515001", status: "verified", confidenceScore: 93 },
    { date: "2026-05-15", narration: "RTGS-Reliance Jio/Enterprise telecom INV-JIO-2026-7", amount: "28900.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026051501", status: "verified", confidenceScore: 89 },
    { date: "2026-05-16", narration: "UPI-MakeMyTrip/Travel booking team offsite", amount: "87000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260516001", status: "unverified", confidenceScore: 35 },
    { date: "2026-05-16", narration: "NEFT-Urban Company/Office maintenance", amount: "12500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260516002", status: "missing_invoice", confidenceScore: 20 },
    { date: "2026-05-17", narration: "RTGS-Tata Consultancy/Digital consulting", amount: "560000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026051701", status: "verified", confidenceScore: 95 },
    { date: "2026-05-17", narration: "IMPS-Paytm Payments/Subscription fees", amount: "9800.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "IMPS2026051701", status: "verified", confidenceScore: 87 },
    { date: "2026-05-18", narration: "UPI-Cashfree Settlement/CF-2026-0518", amount: "145670.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "CF2026051801", status: "verified", confidenceScore: 93 },
    { date: "2026-05-18", narration: "NEFT-Adobe Systems/Creative license INV-ADB-2026-34", amount: "56780.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260518001", status: "verified", confidenceScore: 94 },
    { date: "2026-05-19", narration: "UPI-Contractor payment/Freelancer no invoice attached", amount: "45000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260519001", status: "tds_risk", confidenceScore: 28 },
    { date: "2026-05-19", narration: "NEFT-Salesforce India/CRM INV-SF-2026-201", amount: "125000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260519001", status: "verified", confidenceScore: 96 },
    { date: "2026-05-20", narration: "RTGS-Byju's/EdTech partnership payout", amount: "210000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026052001", status: "unverified", confidenceScore: 58 },
    { date: "2026-05-20", narration: "IMPS-Salary May 2026/Batch transfer EMP-011 to 020", amount: "620000.00", type: "debit", source: "payroll", bankName: "HDFC Bank", reference: "SAL20260520001", status: "verified", confidenceScore: 98 },
    { date: "2026-05-21", narration: "UPI-Razorpay Settlement/May Batch 3/RZP-STL-2347", amount: "267890.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "RZP2347STL", status: "verified", confidenceScore: 95 },
    { date: "2026-05-21", narration: "NEFT-Postman Inc/API platform INV-PM-2026-78", amount: "18900.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260521001", status: "verified", confidenceScore: 91 },
    { date: "2026-05-22", narration: "UPI-Unknown/No narration available", amount: "67000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260522", status: "needs_ca_review", confidenceScore: 10 },
    { date: "2026-05-22", narration: "RTGS-Razorpay Software/Processing fees", amount: "8900.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026052201", status: "verified", confidenceScore: 88 },
    { date: "2026-05-23", narration: "NEFT-Nykaa Fashion/B2B inventory payment", amount: "189000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260523001", status: "verified", confidenceScore: 90 },
    { date: "2026-05-23", narration: "UPI-PhonePe/Vendor payment", amount: "34500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260523001", status: "missing_invoice", confidenceScore: 25 },
    { date: "2026-05-24", narration: "NEFT-Figma Inc/Design tool INV-FIG-2026-12", amount: "28400.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260524001", status: "verified", confidenceScore: 95 },
    { date: "2026-05-24", narration: "RTGS-ICICI Merchant/Gateway refund processed", amount: "12300.00", type: "debit", source: "gateway", bankName: "HDFC Bank", reference: "RTGS2026052401", status: "verified", confidenceScore: 89 },
    { date: "2026-05-25", narration: "UPI-Swiggy Instamart/Office supplies bulk", amount: "18700.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "UPI20260525001", status: "missing_invoice", confidenceScore: 18 },
    { date: "2026-05-25", narration: "NEFT-InVideo AI/Video platform INV-IV-2026-55", amount: "14500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260525001", status: "verified", confidenceScore: 92 },
    { date: "2026-05-26", narration: "RTGS-Meesho Supplier/Product purchase", amount: "320000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026052601", status: "duplicate", confidenceScore: 72 },
    { date: "2026-05-26", narration: "UPI-Cashfree Settlement/CF-2026-0526", amount: "98450.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "CF2026052601", status: "verified", confidenceScore: 94 },
    { date: "2026-05-27", narration: "NEFT-Zendesk Inc/Support platform INV-ZD-2026-23", amount: "32100.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260527001", status: "verified", confidenceScore: 93 },
    { date: "2026-05-27", narration: "IMPS-Salary advance/Employee emergency advance", amount: "50000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "IMPS2026052701", status: "tds_risk", confidenceScore: 35 },
    { date: "2026-05-28", narration: "UPI-Razorpay Settlement/May Batch 4/RZP-STL-2348", amount: "334560.00", type: "credit", source: "gateway", bankName: "HDFC Bank", reference: "RZP2348STL", status: "verified", confidenceScore: 95 },
    { date: "2026-05-28", narration: "NEFT-Stripe Inc/Intl payment gateway INV-STR-2026-9", amount: "67890.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260528001", status: "verified", confidenceScore: 91 },
    { date: "2026-05-29", narration: "RTGS-Meesho Supplier/Product purchase DUPLICATE", amount: "320000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026052901", status: "duplicate", confidenceScore: 72 },
    { date: "2026-05-29", narration: "UPI-Lenskart Solutions/Marketing collab", amount: "95000.00", type: "credit", source: "bank", bankName: "HDFC Bank", reference: "UTR9988776655", status: "unverified", confidenceScore: 48 },
    { date: "2026-05-30", narration: "NEFT-AWS India/Infrastructure INV-AWS-2026-046", amount: "234500.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "NEFT20260530001", status: "verified", confidenceScore: 97 },
    { date: "2026-05-30", narration: "RTGS-BigBasket/B2B supplier payment partial", amount: "125000.00", type: "debit", source: "bank", bankName: "HDFC Bank", reference: "RTGS2026053001", status: "amount_mismatch", confidenceScore: 64 },
  ]).returning();

  // Invoices (30 entries)
  const invoices = await db.insert(invoicesTable).values([
    { invoiceNumber: "INV-2026-001", vendorName: "Zomato Media Ltd", gstin: "27AAECZ1234F1Z5", date: "2026-04-30", amount: "285000.00", gstAmount: "43474.58", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-2026-002", vendorName: "Swiggy Technologies", gstin: "29AABCS5432L1Z7", date: "2026-05-01", amount: "47500.00", gstAmount: "7237.29", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-AWS-2026-045", vendorName: "Amazon Web Services", gstin: "NOTAVAILABLE", date: "2026-05-02", amount: "156200.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-2026-003", vendorName: "Accenture Solutions Pvt Ltd", gstin: "06AACCA6764L1ZF", date: "2026-05-01", amount: "620000.00", gstAmount: "94576.27", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-TCS-001", vendorName: "TCS Ltd", gstin: "27AAACT2727Q1ZY", date: "2026-05-03", amount: "225000.00", gstAmount: "34322.03", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-NOT-789", vendorName: "Notion Labs Inc", gstin: null, date: "2026-05-05", amount: "24500.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-2026-004", vendorName: "Infosys BPM Ltd", gstin: "29AABCI1678L1ZB", date: "2026-05-05", amount: "800000.00", gstAmount: "122033.90", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-GADS-2026-091", vendorName: "Google India Pvt Ltd", gstin: "07AADCG1349P1Z3", date: "2026-05-08", amount: "67800.00", gstAmount: "10342.37", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-2026-005", vendorName: "Myntra Designs Pvt Ltd", gstin: "29AABCM9982G1ZX", date: "2026-05-08", amount: "245000.00", gstAmount: "37372.88", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-HUB-2026-34", vendorName: "HubSpot India", gstin: null, date: "2026-05-09", amount: "45600.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-FW-2026-128", vendorName: "Freshworks Inc", gstin: "33AABCF3456K1Z2", date: "2026-05-11", amount: "32100.00", gstAmount: "4896.61", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-MS-2026-567", vendorName: "Microsoft India Pvt Ltd", gstin: "06AABCM9948G1Z5", date: "2026-05-12", amount: "89450.00", gstAmount: "13644.07", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-SR-2026-445", vendorName: "Shiprocket Pvt Ltd", gstin: "07AACCS2546B1Z4", date: "2026-05-13", amount: "23400.00", gstAmount: "3569.49", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-ZOHO-2026-99", vendorName: "Zoho Corporation", gstin: "33AABCZ5678J1Z1", date: "2026-05-15", amount: "41200.00", gstAmount: "6284.75", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-JIO-2026-7", vendorName: "Reliance Jio Infocomm", gstin: "27AAJCR5658J1ZP", date: "2026-05-15", amount: "28900.00", gstAmount: "4408.47", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-ADB-2026-34", vendorName: "Adobe Systems India", gstin: "29AACCA9889K1Z2", date: "2026-05-18", amount: "56780.00", gstAmount: "8662.71", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-SF-2026-201", vendorName: "Salesforce India", gstin: "29AABCS1234A1Z9", date: "2026-05-19", amount: "125000.00", gstAmount: "19067.80", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-2026-006", vendorName: "Tata Consultancy Services", gstin: "27AAACT2727Q1ZY", date: "2026-05-17", amount: "560000.00", gstAmount: "85423.73", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-PM-2026-78", vendorName: "Postman Inc", gstin: null, date: "2026-05-21", amount: "18900.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-2026-007", vendorName: "Nykaa Fashion Ltd", gstin: "27AANCN2584R1Z8", date: "2026-05-23", amount: "189000.00", gstAmount: "28830.51", type: "sales", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-FIG-2026-12", vendorName: "Figma Inc", gstin: null, date: "2026-05-24", amount: "28400.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-IV-2026-55", vendorName: "InVideo AI", gstin: "27AABCI9876K1Z3", date: "2026-05-25", amount: "14500.00", gstAmount: "2211.86", type: "purchase", paymentStatus: "paid", status: "verified" },
    { invoiceNumber: "INV-ZD-2026-23", vendorName: "Zendesk Inc", gstin: null, date: "2026-05-27", amount: "32100.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-AWS-2026-046", vendorName: "Amazon Web Services", gstin: "NOTAVAILABLE", date: "2026-05-29", amount: "234500.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-STR-2026-9", vendorName: "Stripe Inc", gstin: null, date: "2026-05-28", amount: "67890.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "gst_risk" },
    { invoiceNumber: "INV-2026-008", vendorName: "Zepto Technologies", gstin: "27AACCT5432Q1Z1", date: "2026-05-11", amount: "200000.00", gstAmount: "30508.47", type: "sales", paymentStatus: "partial", status: "amount_mismatch" },
    { invoiceNumber: "INV-2026-009", vendorName: "BigBasket Commerce", gstin: "29AABCB2345N1Z6", date: "2026-05-29", amount: "165000.00", gstAmount: "25169.49", type: "purchase", paymentStatus: "partial", status: "amount_mismatch" },
    { invoiceNumber: "INV-2026-010", vendorName: "Lenskart Solutions", gstin: "07AABCL4567M1Z4", date: "2026-05-29", amount: "95000.00", gstAmount: "14491.53", type: "sales", paymentStatus: "unpaid", status: "unverified" },
    { invoiceNumber: "INV-2026-011", vendorName: "Dunzo Daily", gstin: null, date: "2026-05-13", amount: "15200.00", gstAmount: null, type: "purchase", paymentStatus: "paid", status: "missing_gstin" },
    { invoiceNumber: "INV-2026-012", vendorName: "Byju's", gstin: "29AAECB8765R1Z2", date: "2026-05-20", amount: "210000.00", gstAmount: "32033.90", type: "sales", paymentStatus: "unpaid", status: "unverified" },
  ]).returning();

  // Ledger Entries (20 entries)
  const ledger = await db.insert(ledgerEntriesTable).values([
    { date: "2026-05-01", ledgerName: "Sales Revenue", voucherNumber: "VCH-2026-001", amount: "285000.00", debitCredit: "credit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-01", ledgerName: "Purchase - Software", voucherNumber: "VCH-2026-002", amount: "47500.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-02", ledgerName: "Purchase - Cloud Services", voucherNumber: "VCH-2026-003", amount: "156200.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-02", ledgerName: "Sales Revenue", voucherNumber: "VCH-2026-004", amount: "620000.00", debitCredit: "credit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-03", ledgerName: "Rent Expense", voucherNumber: "VCH-2026-005", amount: "85000.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-04", ledgerName: "Consulting Expense", voucherNumber: "VCH-2026-006", amount: "225000.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-05", ledgerName: "SaaS Subscriptions", voucherNumber: "VCH-2026-007", amount: "24500.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-06", ledgerName: "Sales Revenue", voucherNumber: "VCH-2026-008", amount: "800000.00", debitCredit: "credit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-07", ledgerName: "Suspense Account", voucherNumber: "VCH-2026-009", amount: "20000.00", debitCredit: "debit", sourceTool: "tally", status: "suspense" },
    { date: "2026-05-08", ledgerName: "Marketing Expense", voucherNumber: "VCH-2026-010", amount: "67800.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-09", ledgerName: "SaaS Subscriptions", voucherNumber: "VCH-2026-011", amount: "45600.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-10", ledgerName: "Salary Expense", voucherNumber: "VCH-2026-012", amount: "580000.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-12", ledgerName: "Purchase - Cloud Services", voucherNumber: "VCH-2026-013", amount: "89450.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-14", ledgerName: "Sales Revenue - Gateway", voucherNumber: "VCH-2026-014", amount: "198760.00", debitCredit: "credit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-15", ledgerName: "SaaS Subscriptions", voucherNumber: "VCH-2026-015", amount: "70100.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-17", ledgerName: "Sales Revenue", voucherNumber: "VCH-2026-016", amount: "560000.00", debitCredit: "credit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-18", ledgerName: "Purchase - Design Software", voucherNumber: "VCH-2026-017", amount: "56780.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-19", ledgerName: "CRM Expense", voucherNumber: "VCH-2026-018", amount: "125000.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-20", ledgerName: "Salary Expense", voucherNumber: "VCH-2026-019", amount: "620000.00", debitCredit: "debit", sourceTool: "tally", status: "matched" },
    { date: "2026-05-25", ledgerName: "Missing Voucher - No Ledger", voucherNumber: null, amount: "320000.00", debitCredit: "debit", sourceTool: "tally", status: "missing" },
  ]).returning();

  // Payroll Entries (10 employees)
  const payroll = await db.insert(payrollEntriesTable).values([
    { employeeName: "Arjun Mehta", month: "May 2026", grossAmount: "85000.00", netAmount: "72500.00", paymentDate: "2026-05-10", bankReference: "SAL20260510001", status: "verified" },
    { employeeName: "Priya Sharma", month: "May 2026", grossAmount: "75000.00", netAmount: "64200.00", paymentDate: "2026-05-10", bankReference: "SAL20260510002", status: "verified" },
    { employeeName: "Rohit Agarwal", month: "May 2026", grossAmount: "65000.00", netAmount: "56100.00", paymentDate: "2026-05-10", bankReference: "SAL20260510003", status: "verified" },
    { employeeName: "Sneha Reddy", month: "May 2026", grossAmount: "55000.00", netAmount: "47800.00", paymentDate: "2026-05-10", bankReference: "SAL20260510004", status: "verified" },
    { employeeName: "Kiran Kumar", month: "May 2026", grossAmount: "48000.00", netAmount: "41900.00", paymentDate: "2026-05-10", bankReference: "SAL20260510005", status: "verified" },
    { employeeName: "Divya Nair", month: "May 2026", grossAmount: "120000.00", netAmount: "101000.00", paymentDate: "2026-05-20", bankReference: "SAL20260520001", status: "verified" },
    { employeeName: "Venkat Rao", month: "May 2026", grossAmount: "90000.00", netAmount: "76800.00", paymentDate: "2026-05-20", bankReference: "SAL20260520002", status: "verified" },
    { employeeName: "Anjali Singh", month: "May 2026", grossAmount: "70000.00", netAmount: "60200.00", paymentDate: "2026-05-20", bankReference: "SAL20260520003", status: "verified" },
    { employeeName: "Manish Gupta", month: "May 2026", grossAmount: "82000.00", netAmount: "70100.00", paymentDate: "2026-05-20", bankReference: "SAL20260520004", status: "verified" },
    { employeeName: "Pooja Iyer", month: "May 2026", grossAmount: "95000.00", netAmount: "80600.00", paymentDate: null, bankReference: null, status: "missing" },
  ]).returning();

  // Gateway Settlements (12 entries)
  const settlements = await db.insert(gatewaySettlementsTable).values([
    { provider: "Razorpay", settlementId: "RZP-STL-2345", grossAmount: "318500.00", fees: "3819.00", gstOnFees: "687.42", netAmount: "314000.00", settlementDate: "2026-05-03", bankReference: "RZP2345STL", status: "matched", bankTransactionId: txns[5].id },
    { provider: "Cashfree", settlementId: "CF-2026-0509", grossAmount: "190000.00", fees: "1900.00", gstOnFees: "342.00", netAmount: "187760.00", settlementDate: "2026-05-09", bankReference: "CF2026050901", status: "matched", bankTransactionId: txns[16].id },
    { provider: "Razorpay", settlementId: "RZP-STL-2346", grossAmount: "202000.00", fees: "2424.00", gstOnFees: "436.32", netAmount: "199140.00", settlementDate: "2026-05-14", bankReference: "RZP2346STL", status: "matched", bankTransactionId: txns[27].id },
    { provider: "Cashfree", settlementId: "CF-2026-0518", grossAmount: "148000.00", fees: "1480.00", gstOnFees: "266.40", netAmount: "146254.00", settlementDate: "2026-05-18", bankReference: "CF2026051801", status: "matched", bankTransactionId: txns[34].id },
    { provider: "Razorpay", settlementId: "RZP-STL-2347", grossAmount: "273000.00", fees: "3276.00", gstOnFees: "589.68", netAmount: "269135.00", settlementDate: "2026-05-21", bankReference: "RZP2347STL", status: "matched", bankTransactionId: txns[40].id },
    { provider: "Stripe", settlementId: "STR-2026-0522", grossAmount: "125000.00", fees: "3625.00", gstOnFees: "652.50", netAmount: "120723.00", settlementDate: "2026-05-22", bankReference: null, status: "unmatched", bankTransactionId: null },
    { provider: "Cashfree", settlementId: "CF-2026-0526", grossAmount: "100000.00", fees: "1000.00", gstOnFees: "180.00", netAmount: "98820.00", settlementDate: "2026-05-26", bankReference: "CF2026052601", status: "matched", bankTransactionId: txns[51].id },
    { provider: "Razorpay", settlementId: "RZP-STL-2348", grossAmount: "340000.00", fees: "4080.00", gstOnFees: "734.40", netAmount: "335186.00", settlementDate: "2026-05-28", bankReference: "RZP2348STL", status: "matched", bankTransactionId: txns[54].id },
    { provider: "Stripe", settlementId: "STR-2026-0529", grossAmount: "89000.00", fees: "2581.00", gstOnFees: "464.58", netAmount: "85954.00", settlementDate: "2026-05-29", bankReference: null, status: "fee_mismatch", bankTransactionId: null },
    { provider: "Razorpay", settlementId: "RZP-STL-2349", grossAmount: "178000.00", fees: "2136.00", gstOnFees: "384.48", netAmount: "175480.00", settlementDate: "2026-05-30", bankReference: null, status: "pending", bankTransactionId: null },
    { provider: "Cashfree", settlementId: "CF-2026-0530", grossAmount: "95000.00", fees: "950.00", gstOnFees: "171.00", netAmount: "93879.00", settlementDate: "2026-05-30", bankReference: null, status: "pending", bankTransactionId: null },
    { provider: "Razorpay", settlementId: "RZP-STL-2350", grossAmount: "45000.00", fees: "540.00", gstOnFees: "97.20", netAmount: "44363.00", settlementDate: "2026-05-31", bankReference: null, status: "pending", bankTransactionId: null },
  ]).returning();

  // Reconciliation Matches (25 entries)
  const matches = await db.insert(reconciliationMatchesTable).values([
    { bankTransactionId: txns[0].id, invoiceId: invoices[0].id, matchType: "exact", confidenceScore: 92, reason: "Amount match + UTR in narration + date within 1 day", status: "approved" },
    { bankTransactionId: txns[1].id, invoiceId: invoices[1].id, matchType: "exact", confidenceScore: 88, reason: "Amount match + vendor name match + date within 1 day", status: "approved" },
    { bankTransactionId: txns[2].id, invoiceId: invoices[2].id, matchType: "exact", confidenceScore: 95, reason: "Amount match + invoice number in narration + date same", status: "approved" },
    { bankTransactionId: txns[3].id, invoiceId: invoices[3].id, matchType: "exact", confidenceScore: 91, reason: "Amount match + RTGS ref + vendor match", status: "approved" },
    { bankTransactionId: txns[4].id, invoiceId: null, matchType: "verified", confidenceScore: 97, reason: "Rent payment verified by recurring pattern", status: "approved" },
    { bankTransactionId: txns[6].id, invoiceId: invoices[4].id, matchType: "exact", confidenceScore: 89, reason: "Amount match + invoice number TCS-001 in narration", status: "approved" },
    { bankTransactionId: txns[7].id, invoiceId: null, matchType: "unverified", confidenceScore: 55, reason: "Credit from Flipkart - no invoice found to match", status: "pending" },
    { bankTransactionId: txns[8].id, invoiceId: invoices[5].id, matchType: "exact", confidenceScore: 94, reason: "Amount match + vendor Notion + invoice NOT-789", status: "approved" },
    { bankTransactionId: txns[9].id, invoiceId: null, matchType: "missing_invoice", confidenceScore: 18, reason: "Debit of ₹32,000 with no vendor reference or invoice", status: "pending" },
    { bankTransactionId: txns[10].id, invoiceId: invoices[6].id, matchType: "exact", confidenceScore: 96, reason: "Large RTGS credit matches Infosys BPM invoice", status: "approved" },
    { bankTransactionId: txns[14].id, invoiceId: invoices[7].id, matchType: "exact", confidenceScore: 93, reason: "Google Ads invoice INV-GADS-2026-091 matched", status: "approved" },
    { bankTransactionId: txns[18].id, invoiceId: null, matchType: "verified", confidenceScore: 98, reason: "Salary batch SAL20260510001 matches payroll register", status: "approved" },
    { bankTransactionId: txns[21].id, invoiceId: invoices[10].id, matchType: "exact", confidenceScore: 92, reason: "Freshworks invoice INV-FW-2026-128 matched", status: "approved" },
    { bankTransactionId: txns[22].id, invoiceId: invoices[25].id, matchType: "potential", confidenceScore: 61, reason: "Zepto payment partial - bank ₹1.5L vs invoice ₹2L", status: "pending" },
    { bankTransactionId: txns[23].id, invoiceId: invoices[11].id, matchType: "exact", confidenceScore: 96, reason: "Microsoft Azure INV-MS-2026-567 matched", status: "approved" },
    { bankTransactionId: txns[25].id, invoiceId: invoices[12].id, matchType: "exact", confidenceScore: 90, reason: "Shiprocket INV-SR-2026-445 matched", status: "approved" },
    { bankTransactionId: txns[28].id, invoiceId: null, matchType: "verified", confidenceScore: 98, reason: "Salary batch SAL20260520001 matches payroll register", status: "approved" },
    { bankTransactionId: txns[29].id, invoiceId: null, matchType: "missing_invoice", confidenceScore: 22, reason: "Bigbasket debit with no invoice found", status: "pending" },
    { bankTransactionId: txns[32].id, invoiceId: invoices[17].id, matchType: "exact", confidenceScore: 95, reason: "TCS RTGS credit matches consulting invoice", status: "approved" },
    { bankTransactionId: txns[35].id, invoiceId: invoices[15].id, matchType: "exact", confidenceScore: 94, reason: "Adobe INV-ADB-2026-34 matched", status: "approved" },
    { bankTransactionId: txns[37].id, invoiceId: invoices[16].id, matchType: "exact", confidenceScore: 96, reason: "Salesforce INV-SF-2026-201 matched", status: "approved" },
    { bankTransactionId: txns[51].id, invoiceId: null, matchType: "duplicate", confidenceScore: 72, reason: "Same amount ₹3.2L, same vendor Meesho, 3 days apart - possible duplicate", status: "pending" },
    { bankTransactionId: txns[56].id, invoiceId: null, matchType: "duplicate", confidenceScore: 72, reason: "Duplicate of RTGS2026052601 - same amount and narration", status: "pending" },
    { bankTransactionId: txns[43].id, invoiceId: null, matchType: "tds_risk", confidenceScore: 42, reason: "Vendor advance ₹75k without TDS deduction noted - possible 194C", status: "pending" },
    { bankTransactionId: txns[36].id, invoiceId: null, matchType: "tds_risk", confidenceScore: 28, reason: "Freelancer payment ₹45k without TDS or invoice", status: "pending" },
  ]).returning({ id: reconciliationMatchesTable.id });

  // Risk Flags (15 entries)
  const risks = await db.insert(riskFlagsTable).values([
    { entityType: "invoice", entityId: invoices[2].id, category: "Missing GSTIN", severity: "high", reason: "AWS invoice INV-AWS-2026-045 has no valid GSTIN in the uploaded evidence.", suggestedAction: "Potential risk — needs CA review. Obtain vendor tax details or document treatment with the CA.", status: "open" },
    { entityType: "transaction", entityId: txns[9].id, category: "Invoice Missing", severity: "high", reason: "Debit of INR 32,000 with narration 'Unknown Vendor/Payment no reference' has no linked invoice.", suggestedAction: "Potential risk — needs CA review. Locate the invoice or vendor details before including this in close reports.", status: "open" },
    { entityType: "transaction", entityId: txns[26].id, category: "Possible TDS Deduction", severity: "high", reason: "Vendor advance INR 75,000 to Ola Electric has no TDS deduction note in the uploaded evidence.", suggestedAction: "Potential risk — needs CA review. Verify TDS treatment and supporting documents with the CA.", status: "open" },
    { entityType: "transaction", entityId: txns[36].id, category: "Possible TDS Deduction", severity: "high", reason: "Contractor payment INR 45,000 has no invoice attached and no TDS evidence in the uploaded files.", suggestedAction: "Potential risk — needs CA review. Obtain contractor invoice and confirm TDS treatment with the CA.", status: "open" },
    { entityType: "transaction", entityId: txns[51].id, category: "Duplicate Invoice", severity: "medium", reason: "Meesho Supplier payment appears twice, INR 3,20,000 on 26th and 29th May, with identical narration.", suggestedAction: "Potential risk — needs CA review. Verify whether both payments are genuine before approval.", status: "open" },
    { entityType: "invoice", entityId: invoices[5].id, category: "Missing GSTIN", severity: "medium", reason: "Notion Labs invoice INV-NOT-789 has no GSTIN in the uploaded invoice text.", suggestedAction: "Potential risk — needs CA review. Confirm GST/RCM treatment and document the decision.", status: "open" },
    { entityType: "invoice", entityId: invoices[9].id, category: "Missing GSTIN", severity: "medium", reason: "HubSpot India INV-HUB-2026-34 is missing GSTIN in the uploaded evidence.", suggestedAction: "Potential risk — needs CA review. Request GSTIN or tax invoice from the vendor.", status: "open" },
    { entityType: "transaction", entityId: txns[12].id, category: "High Value Cash Transaction", severity: "medium", reason: "ATM cash withdrawal INR 20,000 on 7 May has no supporting document or business purpose note.", suggestedAction: "Potential risk — needs CA review. Document business purpose and supporting evidence.", status: "open" },
    { entityType: "transaction", entityId: txns[42].id, category: "Invoice Missing", severity: "medium", reason: "Payment of INR 67,000 on 22 May has narration 'Unknown/No narration available' and zero matching confidence.", suggestedAction: "Potential risk — needs CA review. Identify payment recipient and obtain invoice before period close.", status: "open" },
    { entityType: "gateway_settlement", entityId: settlements[8].id, category: "Gateway Fee Mismatch", severity: "medium", reason: "Stripe settlement STR-2026-0529 shows a fee discrepancy against expected rate.", suggestedAction: "Potential risk — needs CA review. Reconcile with the uploaded Stripe settlement export and fee schedule.", status: "open" },
    { entityType: "invoice", entityId: invoices[26].id, category: "Missing GSTIN", severity: "medium", reason: "Invoice INV-2026-011 from Dunzo Daily has no GSTIN in the uploaded evidence.", suggestedAction: "Potential risk — needs CA review. Request tax invoice with GSTIN from the vendor.", status: "open" },
    { entityType: "transaction", entityId: txns[22].id, category: "Amount Mismatch", severity: "medium", reason: "Bank credit INR 1,50,000 from Zepto does not equal invoice INV-2026-008 amount INR 2,00,000.", suggestedAction: "Potential risk — needs CA review. Follow up on the INR 50,000 difference and keep invoice pending.", status: "open" },
    { entityType: "payroll", category: "Payroll Mismatch", severity: "low", reason: "Payroll entry for Pooja Iyer (May 2026) shows no bank payment date or reference.", suggestedAction: "Potential risk — needs CA review. Verify salary payment status with HR and update bank reference.", status: "open" },
    { entityType: "ledger", entityId: ledger[8].id, category: "Suspense Ledger Usage", severity: "low", reason: "ATM withdrawal INR 20,000 is posted to Suspense Account.", suggestedAction: "Potential risk — needs CA review. Remap to the correct ledger after review.", status: "open" },
    { entityType: "invoice", category: "Missing GSTIN", severity: "low", reason: "Multiple international vendor invoices lack Indian GSTIN in the uploaded evidence.", suggestedAction: "Potential risk — needs CA review. Review treatment for foreign SaaS vendor invoices consistently.", status: "open" },
  ]).returning({ id: riskFlagsTable.id });

  // CA Review Items
  const reviews = await db.insert(caReviewItemsTable).values([
    { entityType: "transaction", entityId: txns[26].id, title: "Potential TDS review on vendor advance - Ola Electric INR 75,000", description: "Payment to Ola Electric has no TDS note in the uploaded evidence. Potential risk — needs CA review.", severity: "high", status: "pending", founderNote: "This was an advance for hardware procurement. Need CA guidance." },
    { entityType: "transaction", entityId: txns[36].id, title: "Freelancer payment INR 45,000 without invoice evidence", description: "Payment on 19 May to freelancer has no invoice or TDS evidence attached. Potential risk — needs CA review.", severity: "high", status: "pending", founderNote: "Freelance UI designer for Q1 project. Will get invoice." },
    { entityType: "transaction", entityId: txns[51].id, title: "Duplicate payment to Meesho Supplier - INR 3,20,000", description: "Same amount paid twice on 26th and 29th May. Bank narration nearly identical. Potential risk — needs CA review.", severity: "high", status: "pending", founderNote: "Checking with vendor if both payments are valid." },
    { entityType: "invoice", entityId: invoices[2].id, title: "AWS invoice without GSTIN evidence", description: "INV-AWS-2026-045 INR 1,56,200 has no valid GSTIN in the uploaded evidence. Potential risk — needs CA review.", severity: "high", status: "pending" },
    { entityType: "transaction", entityId: txns[42].id, title: "Unidentified debit INR 67,000 - no narration", description: "Bank debit on 22 May has unknown narration in the uploaded statement. Potential risk — needs CA review.", severity: "high", status: "pending", founderNote: "Checking with accounts team." },
    { entityType: "reconciliation", title: "Zepto partial payment - INR 50,000 difference", description: "Zepto invoice INV-2026-008 for INR 2L received only INR 1.5L in bank evidence. Potential risk — needs CA review.", severity: "medium", status: "pending", founderNote: "Zepto confirmed remaining payment by 5th June." },
    { entityType: "invoice", title: "Foreign SaaS vendor invoice review", description: "AWS, Stripe, Notion, HubSpot, Figma, Postman, and Zendesk invoices lack GSTIN in the uploaded evidence. Potential risk — needs CA review.", severity: "medium", status: "pending" },
    { entityType: "gateway_settlement", entityId: settlements[8].id, title: "Stripe fee discrepancy - STR-2026-0529", description: "Gateway fees do not match expected rate in uploaded exports. Potential risk — needs CA review.", severity: "medium", status: "pending" },
    { entityType: "payroll", title: "Pooja Iyer salary not disbursed - May 2026", description: "Payroll register shows Pooja Iyer INR 80,600 but no corresponding bank debit found. Potential risk — needs CA review.", severity: "low", status: "pending", founderNote: "Will process by 2nd June." },
    { entityType: "ledger", title: "Suspense account usage for ATM withdrawal", description: "INR 20,000 ATM withdrawal mapped to Suspense account. Potential risk — needs CA review.", severity: "low", status: "pending" },
  ]).returning({ id: caReviewItemsTable.id });
  const gstRecords = await db.insert(gstRecordsTable).values([
    {
      companyId: company.id,
      period: "May 2026",
      sourceType: "gstr2b",
      gstin: "27AAECZ1234F1Z5",
      counterpartyName: "Zomato Media Ltd",
      invoiceNumber: "INV-2026-001",
      invoiceDate: "2026-04-30",
      taxableValue: "241525.42",
      gstAmount: "43474.58",
      matchStatus: "matched",
      riskStatus: "none",
    },
    {
      companyId: company.id,
      period: "May 2026",
      sourceType: "gstr2b",
      gstin: null,
      counterpartyName: "Amazon Web Services",
      invoiceNumber: "INV-AWS-2026-045",
      invoiceDate: "2026-05-02",
      taxableValue: "156200.00",
      gstAmount: "0.00",
      matchStatus: "unmatched",
      riskStatus: "missing_gstin",
    },
    {
      companyId: company.id,
      period: "May 2026",
      sourceType: "gstr2b",
      gstin: "29AABCS1234A1Z9",
      counterpartyName: "Salesforce India",
      invoiceNumber: "INV-SF-2026-201",
      invoiceDate: "2026-05-19",
      taxableValue: "105932.20",
      gstAmount: "19067.80",
      matchStatus: "matched",
      riskStatus: "none",
    },
    {
      companyId: company.id,
      period: "May 2026",
      sourceType: "tds",
      gstin: null,
      counterpartyName: "Freelance UI Designer",
      invoiceNumber: null,
      invoiceDate: "2026-05-19",
      taxableValue: "45000.00",
      gstAmount: "0.00",
      matchStatus: "missing_invoice",
      riskStatus: "tds_review",
    },
  ]).returning();

  await db.insert(auditLogsTable).values([
    {
      companyId: company.id,
      userId: users[2].id,
      actorEmail: users[2].email,
      action: "demo.seeded",
      entityType: "company",
      entityId: company.id,
      metadata: { note: "Sample Demo Data seeded for NovaStack Labs Pvt Ltd" },
    },
    {
      companyId: company.id,
      userId: users[0].id,
      actorEmail: users[0].email,
      action: "reconciliation.run",
      entityType: "reconciliation",
      metadata: { matchesCreated: 25, mode: "rule_based" },
    },
    {
      companyId: company.id,
      userId: users[1].id,
      actorEmail: users[1].email,
      action: "ca_review.queue_created",
      entityType: "ca_review",
      metadata: { pendingItems: 10, wording: "Potential risk — needs CA review" },
    },
    {
      companyId: company.id,
      userId: users[2].id,
      actorEmail: users[2].email,
      action: "documents.metadata_captured",
      entityType: "document",
      metadata: { documentCount: uploads.length, storageProvider: "metadata_only" },
    },
  ]);

  // Scope the company backfill to rows this seed just inserted. An unscoped
  // UPDATE here would move every tenant's records into the demo company.
  const ids = <T extends { id: number }>(rows: T[]) => rows.map(row => row.id);
  await db.update(bankTransactionsTable).set({ companyId: company.id }).where(inArray(bankTransactionsTable.id, ids(txns)));
  await db.update(invoicesTable).set({ companyId: company.id }).where(inArray(invoicesTable.id, ids(invoices)));
  await db.update(ledgerEntriesTable).set({ companyId: company.id }).where(inArray(ledgerEntriesTable.id, ids(ledger)));
  await db.update(payrollEntriesTable).set({ companyId: company.id }).where(inArray(payrollEntriesTable.id, ids(payroll)));
  await db.update(gatewaySettlementsTable).set({ companyId: company.id }).where(inArray(gatewaySettlementsTable.id, ids(settlements)));
  await db.update(reconciliationMatchesTable).set({ companyId: company.id }).where(inArray(reconciliationMatchesTable.id, ids(matches)));
  await db.update(riskFlagsTable).set({ companyId: company.id }).where(inArray(riskFlagsTable.id, ids(risks)));
  await db.update(caReviewItemsTable).set({ companyId: company.id }).where(inArray(caReviewItemsTable.id, ids(reviews)));

  return {
    companies: 1,
    users: users.length,
    transactions: txns.length,
    invoices: invoices.length,
    ledgerEntries: ledger.length,
    payrollEntries: payroll.length,
    gatewaySettlements: settlements.length,
    gstRecords: gstRecords.length,
    uploads: uploads.length,
  };
}
