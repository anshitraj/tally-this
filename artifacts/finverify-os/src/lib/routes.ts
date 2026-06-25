export const APP_ROUTES = {
  overview: "/app/overview",
  uploads: "/app/uploads",
  transactions: "/app/transactions",
  invoices: "/app/invoices",
  ledgerMatch: "/app/ledger-match",
  trialBalance: "/app/trial-balance",
  taxAudit: "/app/tax-audit",
  journalEntries: "/app/journal-entries",
  reconciliation: "/app/reconciliation",
  gstTdsRisks: "/app/gst-tds-risks",
  gstr2bRecon: "/app/gstr-2b-recon",
  payroll: "/app/payroll",
  gatewaySettlements: "/app/gateway-settlements",
  caReview: "/app/ca-review",
  reports: "/app/reports",
  integrations: "/app/integrations",
  settings: "/app/settings",
  admin: "/app/admin",
  docs: "/app/docs",
} as const;

export type AppRoute = (typeof APP_ROUTES)[keyof typeof APP_ROUTES];
