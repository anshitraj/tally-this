import { lazy, Suspense } from "react";
import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";
import { ApiError } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import OnboardingPage from "@/pages/onboarding";
import AppShell from "@/components/app/AppShell";
import AppLoading from "@/components/app/AppLoading";
// The shell and the first screen load at once; every other page loads when it is opened.
const OverviewPage = lazy(() => import("@/pages/app/overview"));
const UploadsPage = lazy(() => import("@/pages/app/uploads"));
const TransactionsPage = lazy(() => import("@/pages/app/transactions"));
const InvoicesPage = lazy(() => import("@/pages/app/invoices"));
const LedgerMatchPage = lazy(() => import("@/pages/app/ledger-match"));
const TrialBalancePage = lazy(() => import("@/pages/app/trial-balance"));
const TaxAuditPage = lazy(() => import("@/pages/app/tax-audit"));
const PracticePage = lazy(() => import("@/pages/app/practice"));
const TdsReconPage = lazy(() => import("@/pages/app/tds-recon"));
const JournalEntriesPage = lazy(() => import("@/pages/app/journal-entries"));
const ReconciliationPage = lazy(() => import("@/pages/app/reconciliation"));
const GstTdsRisksPage = lazy(() => import("@/pages/app/gst-tds-risks"));
const Gstr2bReconPage = lazy(() => import("@/pages/app/gstr-2b-recon"));
const GatewaySettlementsPage = lazy(() => import("@/pages/app/gateway-settlements"));
const CaReviewPage = lazy(() => import("@/pages/app/ca-review"));
const ReportsPage = lazy(() => import("@/pages/app/reports"));
const ActionItemsPage = lazy(() => import("@/pages/app/action-items"));
const VerifyPage = lazy(() => import("@/pages/app/verify"));
const StatutoryCalendarPage = lazy(() => import("@/pages/app/statutory-calendar"));
const VendorAgingPage = lazy(() => import("@/pages/app/vendor-aging"));
const IntegrationsPage = lazy(() => import("@/pages/app/integrations"));
const AdminPage = lazy(() => import("@/pages/app/admin"));
const SettingsPage = lazy(() => import("@/pages/app/settings"));
const ClientsPage = lazy(() => import("@/pages/app/clients"));
const ActivityPage = lazy(() => import("@/pages/app/activity"));
const BankToTallyPage = lazy(() => import("@/pages/app/jobs/bank-to-tally"));
const BankTallyPage = lazy(() => import("@/pages/app/jobs/bank-tally"));
const EcommerceGstPage = lazy(() => import("@/pages/app/jobs/ecommerce-gst"));
const InvoiceBankPage = lazy(() => import("@/pages/app/jobs/invoice-bank"));
const Gstr2bJobPage = lazy(() => import("@/pages/app/jobs/gstr-2b"));
const BillsTallyPage = lazy(() => import("@/pages/app/jobs/bills-tally"));
const GstSalesPage = lazy(() => import("@/pages/app/jobs/gst-sales"));
const PayrollJobPage = lazy(() => import("@/pages/app/jobs/payroll"));
// Payroll rows imported earlier through the Upload center keep their own page.
const PayrollImportedPage = lazy(() => import("@/pages/app/payroll"));
const DocsPage = lazy(() => import("@/pages/app/docs"));
const HistoryPage = lazy(() => import("@/pages/app/history"));
const HistoryDetailPage = lazy(() => import("@/pages/app/history").then(module => ({ default: module.HistoryDetailPage })));

/** Background checks that may fail quietly without the person needing to know. */
const QUIET_QUERIES = new Set(["health", "workspaces-tally", "workflow-runs-all"]);
let lastLoadNotice = 0;

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // An ended session sends the person to sign in; it needs no extra message.
      if (error instanceof ApiError && error.status === 401) return;
      if (QUIET_QUERIES.has(String(query.queryKey[0]))) return;
      // Pages that already hold earlier data keep showing it.
      if (query.state.data !== undefined) return;
      // One message for a page full of queries, not one for each.
      const now = Date.now();
      if (now - lastLoadNotice < 12_000) return;
      lastLoadNotice = now;
      toast({
        title: "Some information did not load",
        description: "Check your connection and refresh. Your files and results are safe.",
        variant: "destructive",
      });
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
    },
  },
});

/**
 * Every signed-in page lives inside one shell that stays mounted, so the menu keeps its place,
 * its open sections and its scroll while the page beside it changes.
 */
function AppArea() {
  return (
    <AppShell>
      <Suspense fallback={<AppLoading />}>
      <Switch>
        <Route path="/app" component={OverviewPage} />
        <Route path="/app/overview" component={OverviewPage} />
        <Route path="/app/uploads/advanced"><Redirect to="/app/uploads?view=advanced" /></Route>
        <Route path="/app/advanced-upload"><Redirect to="/app/uploads?view=advanced" /></Route>
        <Route path="/app/uploads" component={UploadsPage} />
        <Route path="/app/transactions" component={TransactionsPage} />
        <Route path="/app/invoices" component={InvoicesPage} />
        <Route path="/app/ledger-match" component={LedgerMatchPage} />
        <Route path="/app/trial-balance" component={TrialBalancePage} />
        <Route path="/app/tax-audit" component={TaxAuditPage} />
        <Route path="/app/practice" component={PracticePage} />
        <Route path="/app/tds-recon" component={TdsReconPage} />
        <Route path="/app/journal-entries" component={JournalEntriesPage} />
        <Route path="/app/gstr-2b-recon" component={Gstr2bReconPage} />
        <Route path="/app/reconciliation" component={ReconciliationPage} />
        <Route path="/app/gst-tds-risks" component={GstTdsRisksPage} />
        <Route path="/app/payroll"><Redirect to="/app/jobs/payroll" /></Route>
        <Route path="/app/payroll-register" component={PayrollImportedPage} />
        <Route path="/app/gateway-settlements" component={GatewaySettlementsPage} />
        <Route path="/app/verify" component={VerifyPage} />
        <Route path="/app/action-items" component={ActionItemsPage} />
        <Route path="/app/statutory-calendar" component={StatutoryCalendarPage} />
        <Route path="/app/vendor-aging" component={VendorAgingPage} />
        <Route path="/app/ca-review" component={CaReviewPage} />
        <Route path="/app/reports" component={ReportsPage} />
        <Route path="/app/integrations" component={IntegrationsPage} />
        <Route path="/app/admin" component={AdminPage} />
        <Route path="/app/clients" component={ClientsPage} />
        <Route path="/app/activity" component={ActivityPage} />
        <Route path="/app/history/:id" component={HistoryDetailPage} />
        <Route path="/app/history" component={HistoryPage} />
        <Route path="/app/jobs/bank-to-tally" component={BankToTallyPage} />
        <Route path="/app/jobs/bank-tally" component={BankTallyPage} />
        <Route path="/app/jobs/ecommerce-gst" component={EcommerceGstPage} />
        <Route path="/app/jobs/invoice-bank" component={InvoiceBankPage} />
        <Route path="/app/jobs/gstr-2b" component={Gstr2bJobPage} />
        <Route path="/app/jobs/bills-tally" component={BillsTallyPage} />
        <Route path="/app/jobs/gst-sales" component={GstSalesPage} />
        <Route path="/app/jobs/payroll" component={PayrollJobPage} />
        <Route path="/app/settings" component={SettingsPage} />
        <Route path="/app/docs" component={DocsPage} />
        <Route path="/app/ledger"><Redirect to="/app/ledger-match" /></Route>
        <Route path="/app/risks"><Redirect to="/app/gst-tds-risks" /></Route>
        <Route path="/app/gateway"><Redirect to="/app/gateway-settlements" /></Route>
        <Route path="/app/review"><Redirect to="/app/ca-review" /></Route>
        <Route>
          <NotFound inApp />
        </Route>
      </Switch>
      </Suspense>
    </AppShell>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route path="/app/*?" component={AppArea} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
