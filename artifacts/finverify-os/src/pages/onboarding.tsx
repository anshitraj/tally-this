import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, FileSpreadsheet, ShieldCheck, UploadCloud, UserRound } from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { getUser, login, type UserRole } from "@/lib/auth";
import { APP_ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingState = {
  account: {
    name: string;
    email: string;
    role: "Founder / Admin" | "Finance Team" | "CA / Auditor" | "Viewer";
  };
  firm: {
    name: string;
    type: "Individual CA" | "CA Firm" | "Virtual CFO" | "Accounting Agency";
    email: string;
    phone: string;
    city: string;
    state: string;
    clientCount: string;
    services: string[];
  };
  company: {
    companyName: string;
    legalName: string;
    businessType: "Private Limited" | "LLP" | "Proprietorship" | "Partnership" | "Other";
    industry: string;
    gstin: string;
    pan: string;
    state: string;
    accountingSystem: string;
    gateways: string[];
    payrollMethod: string;
    closeMonth: string;
  };
  sources: string[];
};

const sourceOptions = ["Bank statement", "Invoices", "Tally export", "Zoho export", "GST/TDS", "Payroll", "Gateway settlement", "Expenses"];
const serviceOptions = ["Monthly close", "GST/TDS review", "Bookkeeping review", "Payroll review", "Startup finance review"];
const gatewayOptions = ["Razorpay", "Cashfree", "Stripe", "Other"];

function onboardingKey(email: string) {
  return `finverify_onboarding:${email}`;
}

function completionKey(email: string) {
  return `finverify_onboarding_complete:${email}`;
}

function selectedSourcesKey(email: string) {
  return `finverify_selected_sources:${email}`;
}

function toggle(items: string[], item: string) {
  return items.includes(item) ? items.filter(existing => existing !== item) : [...items, item];
}

function roleToAuth(role: OnboardingState["account"]["role"]): UserRole {
  if (role === "CA / Auditor") return "ca";
  if (role === "Finance Team") return "finance";
  if (role === "Viewer") return "viewer";
  return "founder";
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition focus:border-primary/50"
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition focus:border-primary/50"
      >
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function OptionButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition",
        active ? "border-primary bg-primary/10 text-foreground shadow-sm" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
      )}
    >
      <span>{children}</span>
      {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

export default function OnboardingPage() {
  const [, navigate] = useLocation();
  const user = getUser();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<OnboardingState>(() => ({
    account: { name: "", email: "", role: "Founder / Admin" },
    firm: { name: "", type: "Individual CA", email: "", phone: "", city: "", state: "", clientCount: "", services: ["Monthly close", "Startup finance review"] },
    company: {
      companyName: "",
      legalName: "",
      businessType: "Private Limited",
      industry: "",
      gstin: "",
      pan: "",
      state: "",
      accountingSystem: "Tally",
      gateways: ["Razorpay"],
      payrollMethod: "Excel",
      closeMonth: "May 2026",
    },
    sources: ["Bank statement", "Tally export"],
  }));

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }
    const saved = localStorage.getItem(onboardingKey(user.email));
    const base = {
      account: { name: user.name, email: user.email, role: "Founder / Admin" as const },
      firm: { name: "", type: "Individual CA" as const, email: user.email, phone: "", city: "", state: "", clientCount: "", services: ["Monthly close", "Startup finance review"] },
      company: {
        companyName: user.company || "Client Company",
        legalName: user.company || "Client Company",
        businessType: "Private Limited" as const,
        industry: "",
        gstin: "",
        pan: "",
        state: "",
        accountingSystem: "Tally",
        gateways: ["Razorpay"],
        payrollMethod: "Excel",
        closeMonth: "May 2026",
      },
      sources: ["Bank statement", "Tally export"],
    };
    if (!saved) {
      setForm(base);
      return;
    }
    try {
      setForm({ ...base, ...JSON.parse(saved) });
    } catch {
      localStorage.removeItem(onboardingKey(user.email));
      setForm(base);
    }
  }, [navigate, user]);

  const steps = useMemo(() => {
    const caSelected = form.account.role === "CA / Auditor";
    return [
      "Account",
      ...(caSelected ? ["Firm"] : []),
      "Client",
      "Sources",
      "Guide",
    ];
  }, [form.account.role]);

  if (!user) return null;

  const current = steps[step];
  const isLast = step === steps.length - 1;

  const finish = () => {
    const payload = { ...form, completedAt: new Date().toISOString() };
    localStorage.setItem(onboardingKey(user.email), JSON.stringify(payload));
    localStorage.setItem(completionKey(user.email), "true");
    localStorage.setItem(selectedSourcesKey(user.email), JSON.stringify(form.sources));
    login({
      user: {
        ...user,
        name: form.account.name || user.name,
        email: form.account.email || user.email,
        role: roleToAuth(form.account.role),
        company: form.company.companyName || user.company,
      },
    });
    // CAs land on the Tax Audit cockpit (the headline screen); others on Upload.
    navigate(form.account.role === "CA / Auditor" ? APP_ROUTES.taxAudit : APP_ROUTES.uploads);
  };

  const updateAccount = (patch: Partial<OnboardingState["account"]>) => setForm(currentForm => ({ ...currentForm, account: { ...currentForm.account, ...patch } }));
  const updateFirm = (patch: Partial<OnboardingState["firm"]>) => setForm(currentForm => ({ ...currentForm, firm: { ...currentForm.firm, ...patch } }));
  const updateCompany = (patch: Partial<OnboardingState["company"]>) => setForm(currentForm => ({ ...currentForm, company: { ...currentForm.company, ...patch } }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="fv-container flex h-16 items-center justify-between">
          <BrandMark />
          <button type="button" onClick={() => navigate(APP_ROUTES.uploads)} className="fv-button-ghost">Skip for now</button>
        </div>
      </header>

      <main className="fv-container grid gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:py-12">
        <motion.section key={current} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="fv-card p-5 sm:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-primary">
                <ShieldCheck className="h-3.5 w-3.5" />
                {current}
              </div>
              <h1 className="text-3xl font-bold tracking-tight">
                {current === "Account" && "Set up your FinVerify workspace"}
                {current === "Firm" && "Create your CA firm workspace"}
                {current === "Client" && "Add the client company"}
                {current === "Sources" && "Select what the client can upload now"}
                {current === "Guide" && (form.account.role === "CA / Auditor" ? "Run your first ledger scrutiny" : "Start with any files you have")}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                {current === "Guide" ? "You do not need all files to start. FinVerify will show matching options based on uploaded sources." : "This keeps the upload-based MVP guided and CA-friendly without claiming live integrations."}
              </p>
            </div>
            <div className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">{step + 1} of {steps.length}</div>
          </div>

          {current === "Account" && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" value={form.account.name} onChange={value => updateAccount({ name: value })} />
                <Field label="Email" value={form.account.email} onChange={value => updateAccount({ email: value })} />
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Role</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(["Founder / Admin", "Finance Team", "CA / Auditor", "Viewer"] as const).map(role => (
                    <OptionButton key={role} active={form.account.role === role} onClick={() => updateAccount({ role })}>{role}</OptionButton>
                  ))}
                </div>
              </div>
            </div>
          )}

          {current === "Firm" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="CA/Firm name" value={form.firm.name} onChange={value => updateFirm({ name: value })} />
              <SelectField label="Firm type" value={form.firm.type} options={["Individual CA", "CA Firm", "Virtual CFO", "Accounting Agency"]} onChange={value => updateFirm({ type: value as OnboardingState["firm"]["type"] })} />
              <Field label="Firm email" value={form.firm.email} onChange={value => updateFirm({ email: value })} />
              <Field label="Phone" value={form.firm.phone} onChange={value => updateFirm({ phone: value })} />
              <Field label="City" value={form.firm.city} onChange={value => updateFirm({ city: value })} />
              <Field label="State" value={form.firm.state} onChange={value => updateFirm({ state: value })} />
              <Field label="Number of clients handled" value={form.firm.clientCount} onChange={value => updateFirm({ clientCount: value })} />
              <div>
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Services offered</div>
                <div className="grid gap-2">
                  {serviceOptions.map(service => (
                    <OptionButton key={service} active={form.firm.services.includes(service)} onClick={() => updateFirm({ services: toggle(form.firm.services, service) })}>{service}</OptionButton>
                  ))}
                </div>
              </div>
            </div>
          )}

          {current === "Client" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company name" value={form.company.companyName} onChange={value => updateCompany({ companyName: value })} />
              <Field label="Legal name" value={form.company.legalName} onChange={value => updateCompany({ legalName: value })} />
              <SelectField label="Business type" value={form.company.businessType} options={["Private Limited", "LLP", "Proprietorship", "Partnership", "Other"]} onChange={value => updateCompany({ businessType: value as OnboardingState["company"]["businessType"] })} />
              <Field label="Industry" value={form.company.industry} onChange={value => updateCompany({ industry: value })} />
              <Field label="GSTIN" value={form.company.gstin} onChange={value => updateCompany({ gstin: value })} />
              <Field label="PAN" value={form.company.pan} onChange={value => updateCompany({ pan: value })} />
              <Field label="State" value={form.company.state} onChange={value => updateCompany({ state: value })} />
              <SelectField label="Accounting system used" value={form.company.accountingSystem} options={["Tally", "Zoho Books", "Excel", "QuickBooks", "Other"]} onChange={value => updateCompany({ accountingSystem: value })} />
              <SelectField label="Payroll method" value={form.company.payrollMethod} options={["Excel", "Payroll software", "Manual"]} onChange={value => updateCompany({ payrollMethod: value })} />
              <Field label="Monthly close month/year" value={form.company.closeMonth} onChange={value => updateCompany({ closeMonth: value })} />
              <div className="sm:col-span-2">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Payment gateways used</div>
                <div className="grid gap-3 sm:grid-cols-4">
                  {gatewayOptions.map(gateway => <OptionButton key={gateway} active={form.company.gateways.includes(gateway)} onClick={() => updateCompany({ gateways: toggle(form.company.gateways, gateway) })}>{gateway}</OptionButton>)}
                </div>
              </div>
            </div>
          )}

          {current === "Sources" && (
            <div className="grid gap-3 sm:grid-cols-2">
              {sourceOptions.map(source => <OptionButton key={source} active={form.sources.includes(source)} onClick={() => setForm(currentForm => ({ ...currentForm, sources: toggle(currentForm.sources, source) }))}>{source}</OptionButton>)}
            </div>
          )}

          {current === "Guide" && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-bold text-primary"><ShieldCheck className="h-4 w-4" />Tax Audit & Ledger Scrutiny — start here</div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Export a Day Book from Tally (<span className="font-mono text-xs">Gateway of Tally → Display → Day Book → Alt+E → XML</span>) and import it on the Tax Audit screen. FinVerify runs 20 clause-mapped checks — 269SS/ST, 40A(3), MSME, depreciation, negative balances and more — then exports a CA-ready evidence pack.
                </p>
                <div className="mt-3 text-xs font-semibold text-primary">No Tally file yet? The cockpit opens with demo data so you can explore every check.</div>
              </div>
              <div className="rounded-2xl border border-border bg-background p-5">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><UploadCloud className="h-4 w-4 text-primary" />Reconciliation guide</div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Upload any files you have. You do not need all files to start. FinVerify will show matching options based on uploaded sources.
                </p>
                <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  <div>Tally Day Book {"->"} Tax Audit scrutiny</div>
                  <div>Bank + Tally {"->"} Ledger reconciliation</div>
                  <div>Bank + Invoices {"->"} Payment reconciliation</div>
                  <div>Bank + Gateway {"->"} Settlement reconciliation</div>
                  <div>GST/TDS only {"->"} GST/TDS review pack</div>
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" onClick={() => setStep(currentStep => Math.max(0, currentStep - 1))} className="fv-button-secondary" disabled={step === 0}>
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
            <button type="button" onClick={() => (isLast ? finish() : setStep(currentStep => currentStep + 1))} className="fv-button-primary">
              {isLast ? (form.account.role === "CA / Auditor" ? "Open Tax Audit Cockpit" : "Go to Upload Center") : "Continue"} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </motion.section>

        <aside className="fv-card-flat h-fit bg-card p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Building2 className="h-5 w-5" /></div>
            <div>
              <div className="text-sm font-semibold">Workspace preview</div>
              <div className="text-xs text-muted-foreground">Saved locally for the MVP session</div>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-background p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role</div>
              <div className="mt-2 text-sm font-semibold">{form.account.role}</div>
            </div>
            {form.account.role === "CA / Auditor" && (
              <div className="rounded-xl border border-border bg-background p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Firm</div>
                <div className="mt-2 text-sm font-semibold">{form.firm.name || "Create firm workspace"}</div>
                <div className="mt-1 text-xs text-muted-foreground">{form.firm.type}</div>
              </div>
            )}
            <div className="rounded-xl border border-border bg-background p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Client company</div>
              <div className="mt-2 text-sm font-semibold">{form.company.companyName || "Client Company"}</div>
              <div className="mt-1 text-xs text-muted-foreground">{form.company.accountingSystem} / {form.company.closeMonth}</div>
            </div>
            <div className="rounded-xl border border-border bg-background p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upload sources</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {form.sources.map(source => <span key={source} className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-semibold">{source}</span>)}
              </div>
            </div>
            <div className="fv-status-missing rounded-xl border p-4 text-xs leading-5">
              Potential risk — needs CA review language is used for compliance issues. AI suggestions stay pending review.
            </div>
          </div>
          <div className="mt-5 flex items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
            <UserRound className="h-4 w-4 shrink-0 text-primary" />
            Signed in as {user.email}
          </div>
        </aside>
      </main>
    </div>
  );
}
