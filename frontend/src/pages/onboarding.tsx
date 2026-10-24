import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Building, Briefcase, Check } from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { Choice, MoreOptions } from "@/components/jobs/jobUi";
import { AUTOMATIONS } from "@/pages/app/overview";
import { getAuthToken, getUser, login, onboardingDoneKey } from "@/lib/auth";
import { setActiveClient } from "@/lib/activeClient";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Who = "clients" | "business";
type Accounting = "Tally" | "Zoho" | "Other";
type Step = 2 | 3;

const WHO: Array<{ id: Who; label: string; detail: string; icon: typeof Briefcase }> = [
  { id: "clients", label: "I work for clients", detail: "CA firm or accountant", icon: Briefcase },
  { id: "business", label: "It's my own business", detail: "I keep my company's books", icon: Building },
];

/** What the person has typed so far, kept for this tab so a refresh does not start the setup again. */
interface Draft {
  step: Step;
  who: Who;
  accounting: Accounting;
  clientName: string;
  businessName: string;
  fullName: string;
  firmName: string;
}

const draftKey = (email: string) => `finverify_onboarding_draft:${email}`;

function readDraft(email: string): Partial<Draft> {
  try {
    const raw = sessionStorage.getItem(draftKey(email));
    return raw ? (JSON.parse(raw) as Partial<Draft>) : {};
  } catch {
    return {};
  }
}

/** A name made up at sign-up (the start of the email, or "X's workspace") is not shown back as if the person typed it. */
function suggested(value: string | undefined, email: string, placeholderPattern?: RegExp) {
  const text = (value ?? "").trim();
  if (!text || text === email.split("@")[0] || (placeholderPattern && placeholderPattern.test(text))) return "";
  return text;
}

/**
 * Account creation was step 1, on the sign-up page. Step 2 adds the first client (one name, two pick-one questions)
 * and step 3 opens the first job. Everything else is under More options or asked later by the job that needs it.
 */
export default function OnboardingPage() {
  const [, navigate] = useLocation();
  const user = getUser();
  const email = user?.email ?? "";
  const saved = readDraft(email);

  const [step, setStep] = useState<Step>(saved.step === 3 ? 3 : 2);
  const [who, setWho] = useState<Who>(saved.who ?? "clients");
  const [accounting, setAccounting] = useState<Accounting>(saved.accounting ?? "Tally");
  const [clientName, setClientName] = useState(saved.clientName ?? "");
  const [businessName, setBusinessName] = useState(saved.businessName ?? suggested(user?.company, email, /'s workspace$/i));
  const [fullName, setFullName] = useState(saved.fullName ?? suggested(user?.name, email));
  const [firmName, setFirmName] = useState(saved.firmName ?? suggested(user?.company, email, /'s workspace$/i));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const alreadyDone = Boolean(user) && localStorage.getItem(onboardingDoneKey(email)) === "true";

  useEffect(() => {
    if (!user) navigate("/login", { replace: true });
    // Someone who has finished setting up never sees it again (Back button, an old link, a second visit).
    else if (alreadyDone) navigate("/app/overview", { replace: true });
  }, [user, alreadyDone, navigate]);

  useEffect(() => {
    if (!email) return;
    try {
      sessionStorage.setItem(draftKey(email), JSON.stringify({ step, who, accounting, clientName, businessName, fullName, firmName } satisfies Draft));
    } catch {
      // A blocked storage only means a refresh starts the step again.
    }
  }, [email, step, who, accounting, clientName, businessName, fullName, firmName]);

  if (!user || alreadyDone) return null;

  const ownBusiness = who === "business";

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  /** Saves the person's own name and firm, only where they differ from what the account already has. */
  const saveProfile = async (company: string) => {
    const name = fullName.trim();
    const changes: { name?: string; companyName?: string } = {};
    if (name && name !== user.name) changes.name = name;
    if (company && company !== user.company) changes.companyName = company;
    if (!changes.name && !changes.companyName) return true;
    const { response, data } = await post("/api/account/profile", changes);
    if (!response.ok || !data.ok) {
      setError(data.error || "Your details could not be saved. Try again.");
      return false;
    }
    login({ user: { ...user, name: changes.name ?? user.name, company: changes.companyName ?? user.company }, token: getAuthToken() ?? undefined });
    return true;
  };

  const continueFromClient = async (skip: boolean) => {
    setError("");
    setBusy(true);
    try {
      const firm = ownBusiness ? businessName.trim() : firmName.trim();
      if (!(await saveProfile(firm))) return;
      const ownCompany = firm || suggested(user.company, email, /'s workspace$/i) || "My business";
      const name = clientName.trim();
      if (ownBusiness || skip || !name) {
        setActiveClient({ id: user.companyId ?? null, name: ownCompany, accounting });
        setStep(3);
        return;
      }
      const { response, data } = await post("/api/practice/clients", { name });
      // The same client sent twice (a refresh, a second click) answers 409 with the one that exists: use it.
      const client = data.client as { companyId: number; name: string; linkId: number } | undefined;
      if ((!response.ok && response.status !== 409) || !client) {
        setError(data.error || "Could not add the client. Try again.");
        return;
      }
      setActiveClient({ id: client.companyId, name: client.name, accounting, linkId: client.linkId });
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const finish = (href: string) => {
    localStorage.setItem(onboardingDoneKey(email), "true");
    try {
      sessionStorage.removeItem(draftKey(email));
    } catch {
      // nothing to clean up
    }
    // Replaces this page in the history, so the Back button leaves setup behind instead of returning to it.
    navigate(href, { replace: true });
  };

  const stages: Array<{ n: number; label: string }> = [
    { n: 1, label: "Account" },
    { n: 2, label: "Client" },
    { n: 3, label: "First job" },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
          <BrandMark />
          <ol className="flex items-center gap-3 text-xs font-semibold text-muted-foreground" aria-label={`Step ${step} of 3`}>
            {stages.map(stage => {
              const done = stage.n < step;
              const current = stage.n === step;
              return (
                <li key={stage.n} aria-current={current ? "step" : undefined} className={cn("flex items-center gap-1.5", current && "text-foreground")}>
                  <span
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
                      done ? "bg-[var(--fv-accent)] text-white" : current ? "border-2 border-[var(--fv-accent)] text-foreground" : "border border-border",
                    )}
                  >
                    {done ? <Check className="h-3 w-3" aria-hidden="true" /> : stage.n}
                  </span>
                  <span className="hidden sm:inline">{stage.label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        {step === 2 && (
          <section>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{ownBusiness ? "Confirm your business" : "Add your first client"}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {ownBusiness ? "This is the business whose books you will work on." : "It takes a minute. You can add more clients later."}
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2" role="group" aria-label="Who are you">
              {WHO.map(item => {
                const Icon = item.icon;
                const selected = who === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setWho(item.id)}
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

            <form
              className="mt-6 rounded-2xl border border-border bg-card p-5"
              onSubmit={event => { event.preventDefault(); if (!busy) void continueFromClient(false); }}
            >
              {ownBusiness ? (
                <>
                  <label htmlFor="business-name" className="text-sm font-semibold">Your business name</label>
                  <input
                    id="business-name"
                    name="organization"
                    autoComplete="organization"
                    autoFocus
                    value={businessName}
                    onChange={event => setBusinessName(event.target.value)}
                    placeholder="e.g. Sharma Traders"
                    className="fv-input mt-2 h-12 w-full text-base"
                  />
                </>
              ) : (
                <>
                  <label htmlFor="client-name" className="text-sm font-semibold">Client's business name</label>
                  <input
                    id="client-name"
                    autoFocus
                    value={clientName}
                    onChange={event => setClientName(event.target.value)}
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

              <MoreOptions label="Your name and firm (optional)">
                <div>
                  <label htmlFor="full-name" className="text-sm font-semibold">Your name</label>
                  <input
                    id="full-name"
                    name="name"
                    autoComplete="name"
                    value={fullName}
                    onChange={event => setFullName(event.target.value)}
                    placeholder="Aarav Sharma"
                    className="fv-input mt-2 h-11 w-full"
                  />
                </div>
                {!ownBusiness && (
                  <div>
                    <label htmlFor="firm-name" className="text-sm font-semibold">Your firm</label>
                    <input
                      id="firm-name"
                      name="firm"
                      autoComplete="organization"
                      value={firmName}
                      onChange={event => setFirmName(event.target.value)}
                      placeholder="Mehta & Associates"
                      className="fv-input mt-2 h-11 w-full"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">Shown on reports. You can change both later in Settings.</p>
                  </div>
                )}
              </MoreOptions>

              {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" disabled={busy} className="text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => void continueFromClient(true)}>Skip for now</button>
                <button
                  type="submit"
                  className="fv-button-primary h-12 px-8 text-base"
                  disabled={busy || !(ownBusiness ? businessName : clientName).trim()}
                >
                  {busy ? "Saving…" : "Continue"}
                </button>
              </div>
            </form>
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
