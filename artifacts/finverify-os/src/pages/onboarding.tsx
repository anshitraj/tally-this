import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Briefcase, Building, Calculator } from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { Choice } from "@/components/jobs/jobUi";
import { AUTOMATIONS } from "@/pages/app/overview";
import { getAuthToken, getUser, login } from "@/lib/auth";
import { setActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Role = "ca" | "accountant" | "business";
type Accounting = "Tally" | "Zoho" | "Other";

const ROLES: Array<{ id: Role; label: string; detail: string; icon: typeof Briefcase }> = [
  { id: "ca", label: "CA / CA firm", detail: "I handle books for many clients", icon: Briefcase },
  { id: "accountant", label: "Accountant", detail: "I keep books for a few businesses", icon: Calculator },
  { id: "business", label: "Business owner", detail: "I manage my own company's books", icon: Building },
];

/** Account creation is step 1 (on the sign-up screen). This page is steps 2 and 3. */
export default function OnboardingPage() {
  const [, navigate] = useLocation();
  const user = getUser();
  const [step, setStep] = useState<2 | 3>(2);
  const [role, setRole] = useState<Role>("ca");
  const [clientName, setClientName] = useState("");
  const [accounting, setAccounting] = useState<Accounting>("Tally");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!user) navigate("/login");
  }, [user, navigate]);

  if (!user) return null;

  const ownBusiness = role === "business";

  const saveClient = async (skip: boolean) => {
    setError("");
    const name = clientName.trim();
    if (ownBusiness || skip || !name) {
      setActiveClient({ id: user.companyId ?? null, name: user.company || "My business", accounting });
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${BASE}/api/practice/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.client) {
        setError(body.error || "Could not add the client. Try again.");
        return;
      }
      setActiveClient({ id: body.client.companyId, name: body.client.name, accounting, linkId: body.client.linkId });
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const finish = (href: string) => {
    localStorage.setItem(`finverify_onboarding_complete:${user.email}`, "true");
    login({
      user: { ...user, role: role === "ca" ? "ca" : role === "accountant" ? "finance" : "founder" },
      token: getAuthToken() ?? undefined,
    });
    navigate(href);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
          <BrandMark />
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            Step {step} of 3
            <span className="flex gap-1">
              {[1, 2, 3].map(index => <span key={index} className={cn("h-1.5 w-6 rounded-full", index <= step ? "bg-[var(--fv-accent)]" : "bg-muted")} />)}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        {step === 2 && (
          <section>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Who are you?</h1>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {ROLES.map(item => {
                const Icon = item.icon;
                const selected = role === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setRole(item.id)}
                    aria-pressed={selected}
                    className={cn(
                      "rounded-2xl border bg-card p-4 text-left transition",
                      selected ? "border-[var(--fv-accent)] ring-2 ring-[var(--fv-accent)]/20" : "border-border hover:border-foreground/30",
                    )}
                  >
                    <Icon className={cn("h-5 w-5", selected ? "text-[var(--fv-accent-dark)]" : "text-muted-foreground")} />
                    <div className="mt-3 text-sm font-semibold">{item.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.detail}</div>
                  </button>
                );
              })}
            </div>

            <div className="mt-8 rounded-2xl border border-border bg-card p-5">
              {ownBusiness ? (
                <>
                  <div className="text-sm text-muted-foreground">Your business</div>
                  <div className="mt-1 text-lg font-semibold">{user.company || "My business"}</div>
                </>
              ) : (
                <>
                  <label htmlFor="client-name" className="text-sm font-semibold">Your first client's business name</label>
                  <input
                    id="client-name"
                    autoFocus
                    value={clientName}
                    onChange={event => setClientName(event.target.value)}
                    onKeyDown={event => { if (event.key === "Enter" && clientName.trim()) void saveClient(false); }}
                    placeholder="e.g. Sharma Traders"
                    className="fv-input mt-2 h-12 w-full text-base"
                  />
                  <p className="mt-2 text-xs text-muted-foreground">GSTIN, PAN and other details are only asked for when a job needs them.</p>
                </>
              )}
              <div className="mt-5">
                <div className="mb-2 text-sm font-semibold">Books are kept in</div>
                <Choice<Accounting>
                  value={accounting}
                  onChange={setAccounting}
                  options={[{ value: "Tally", label: "Tally" }, { value: "Zoho", label: "Zoho Books" }, { value: "Other", label: "Something else" }]}
                />
              </div>
            </div>

            {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              {!ownBusiness ? (
                <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => saveClient(true)}>Skip for now</button>
              ) : <span />}
              <button
                type="button"
                className="fv-button-primary h-12 px-8 text-base"
                disabled={busy || (!ownBusiness && !clientName.trim())}
                onClick={() => saveClient(false)}
              >
                {busy ? "Saving…" : "Continue"}
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">What do you want to do first?</h1>
            <p className="mt-2 text-sm text-muted-foreground">You can use every automation later. Pick one to start.</p>
            <div className="mt-6 grid gap-3">
              {AUTOMATIONS.map(item => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => finish(item.href)}
                    className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left transition hover:border-[var(--fv-accent)]/60 hover:shadow-sm"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{item.title}</span>
                      <span className="block text-sm text-muted-foreground">{item.detail}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                  </button>
                );
              })}
            </div>
            <button type="button" className="mt-6 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => finish("/app/overview")}>I'll decide later — take me home</button>
          </section>
        )}
      </main>
    </div>
  );
}
