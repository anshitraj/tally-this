import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import OnboardingPage from "@/pages/onboarding";
import AppShell from "@/components/app/AppShell";
import OverviewPage from "@/pages/app/overview";
import UploadsPage from "@/pages/app/uploads";
import TransactionsPage from "@/pages/app/transactions";
import InvoicesPage from "@/pages/app/invoices";
import LedgerMatchPage from "@/pages/app/ledger-match";
import TrialBalancePage from "@/pages/app/trial-balance";
import TaxAuditPage from "@/pages/app/tax-audit";
import PracticePage from "@/pages/app/practice";
import TdsReconPage from "@/pages/app/tds-recon";
import JournalEntriesPage from "@/pages/app/journal-entries";
import ReconciliationPage from "@/pages/app/reconciliation";
import GstTdsRisksPage from "@/pages/app/gst-tds-risks";
import Gstr2bReconPage from "@/pages/app/gstr-2b-recon";
import PayrollPage from "@/pages/app/payroll";
import GatewaySettlementsPage from "@/pages/app/gateway-settlements";
import CaReviewPage from "@/pages/app/ca-review";
import ReportsPage from "@/pages/app/reports";
import ActionItemsPage from "@/pages/app/action-items";
import VerifyPage from "@/pages/app/verify";
import StatutoryCalendarPage from "@/pages/app/statutory-calendar";
import VendorAgingPage from "@/pages/app/vendor-aging";
import IntegrationsPage from "@/pages/app/integrations";
import AdminPage from "@/pages/app/admin";
import SettingsPage from "@/pages/app/settings";
import DocsPage from "@/pages/app/docs";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
    },
  },
});

function withShell(Component: React.ComponentType) {
  return function WrappedWithShell() {
    return (
      <AppShell>
        <Component />
      </AppShell>
    );
  };
}

const OverviewWithShell = withShell(OverviewPage);
const UploadsWithShell = withShell(UploadsPage);
const TransactionsWithShell = withShell(TransactionsPage);
const InvoicesWithShell = withShell(InvoicesPage);
const LedgerMatchWithShell = withShell(LedgerMatchPage);
const TrialBalanceWithShell = withShell(TrialBalancePage);
const TaxAuditWithShell = withShell(TaxAuditPage);
const PracticeWithShell = withShell(PracticePage);
const TdsReconWithShell = withShell(TdsReconPage);
const JournalEntriesWithShell = withShell(JournalEntriesPage);
const Gstr2bReconWithShell = withShell(Gstr2bReconPage);
const ReconciliationWithShell = withShell(ReconciliationPage);
const GstTdsRisksWithShell = withShell(GstTdsRisksPage);
const PayrollWithShell = withShell(PayrollPage);
const GatewaySettlementsWithShell = withShell(GatewaySettlementsPage);
const CaReviewWithShell = withShell(CaReviewPage);
const ReportsWithShell = withShell(ReportsPage);
const ActionItemsWithShell = withShell(ActionItemsPage);
const VerifyWithShell = withShell(VerifyPage);
const StatutoryCalendarWithShell = withShell(StatutoryCalendarPage);
const VendorAgingWithShell = withShell(VendorAgingPage);
const IntegrationsWithShell = withShell(IntegrationsPage);
const AdminWithShell = withShell(AdminPage);
const SettingsWithShell = withShell(SettingsPage);
const DocsWithShell = withShell(DocsPage);

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route path="/app" component={OverviewWithShell} />
      <Route path="/app/overview" component={OverviewWithShell} />
      <Route path="/app/uploads" component={UploadsWithShell} />
      <Route path="/app/transactions" component={TransactionsWithShell} />
      <Route path="/app/invoices" component={InvoicesWithShell} />
      <Route path="/app/ledger-match" component={LedgerMatchWithShell} />
      <Route path="/app/trial-balance" component={TrialBalanceWithShell} />
      <Route path="/app/tax-audit" component={TaxAuditWithShell} />
      <Route path="/app/practice" component={PracticeWithShell} />
      <Route path="/app/tds-recon" component={TdsReconWithShell} />
      <Route path="/app/journal-entries" component={JournalEntriesWithShell} />
      <Route path="/app/gstr-2b-recon" component={Gstr2bReconWithShell} />
      <Route path="/app/reconciliation" component={ReconciliationWithShell} />
      <Route path="/app/gst-tds-risks" component={GstTdsRisksWithShell} />
      <Route path="/app/payroll" component={PayrollWithShell} />
      <Route path="/app/gateway-settlements" component={GatewaySettlementsWithShell} />
      <Route path="/app/verify" component={VerifyWithShell} />
      <Route path="/app/action-items" component={ActionItemsWithShell} />
      <Route path="/app/statutory-calendar" component={StatutoryCalendarWithShell} />
      <Route path="/app/vendor-aging" component={VendorAgingWithShell} />
      <Route path="/app/ca-review" component={CaReviewWithShell} />
      <Route path="/app/reports" component={ReportsWithShell} />
      <Route path="/app/integrations" component={IntegrationsWithShell} />
      <Route path="/app/admin" component={AdminWithShell} />
      <Route path="/app/settings" component={SettingsWithShell} />
      <Route path="/app/docs" component={DocsWithShell} />
      <Route path="/app/ledger"><Redirect to="/app/ledger-match" /></Route>
      <Route path="/app/risks"><Redirect to="/app/gst-tds-risks" /></Route>
      <Route path="/app/gateway"><Redirect to="/app/gateway-settlements" /></Route>
      <Route path="/app/review"><Redirect to="/app/ca-review" /></Route>
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
