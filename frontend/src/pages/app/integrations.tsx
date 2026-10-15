import { useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, CheckCircle2, Loader2, Plug, ShieldCheck } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { BrandLogo, LogoStrip } from "@/components/app/BrandLogo";
import { Notice, getJson } from "@/components/jobs/jobUi";

interface TallyStatus {
  running?: boolean;
  companies?: string[];
  message?: string;
}

const SOURCES: Array<{
  title: string;
  formats: string;
  detail: string;
  logos: string[];
  job: { label: string; href: string };
}> = [
  {
    title: "Bank statements",
    formats: "PDF · Excel · CSV · photos",
    detail: "Read row by row and checked against the bank’s own running balance.",
    logos: ["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Punjab National Bank"],
    job: { label: "Bank → Tally", href: "/app/jobs/bank-to-tally" },
  },
  {
    title: "Tally exports",
    formats: "XML · Excel · CSV · PDF",
    detail: "Bank ledger, Day Book or Purchase Register, exported from TallyPrime.",
    logos: ["Tally"],
    job: { label: "Bank ↔ Tally", href: "/app/jobs/bank-tally" },
  },
  {
    title: "Marketplace reports",
    formats: "Excel · CSV",
    detail: "Sales, returns and TCS, split into B2B, B2C and HSN.",
    logos: ["Amazon", "Flipkart", "Meesho", "Myntra", "JioMart"],
    job: { label: "E-commerce GST", href: "/app/jobs/ecommerce-gst" },
  },
  {
    title: "GST portal files",
    formats: "GSTR-2B JSON · Excel",
    detail: "Matched with your purchase register, with ITC at risk listed by supplier.",
    logos: [],
    job: { label: "GSTR-2B ↔ Books", href: "/app/jobs/gstr-2b" },
  },
  {
    title: "Invoices",
    formats: "PDF · Excel · CSV",
    detail: "Matched with payments in the bank statement.",
    logos: [],
    job: { label: "Invoice ↔ Bank", href: "/app/jobs/invoice-bank" },
  },
  {
    title: "Other accounting software",
    formats: "Excel · CSV",
    detail: "A purchase register or invoice list from Zoho Books or any billing software.",
    logos: ["Zoho Books", "QuickBooks"],
    job: { label: "GSTR-2B ↔ Books", href: "/app/jobs/gstr-2b" },
  },
];

export default function IntegrationsPage() {
  const [, navigate] = useLocation();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<TallyStatus | null>(null);

  const check = async () => {
    setChecking(true);
    const response = await getJson<TallyStatus>("/api/jobs/tally/status");
    setChecking(false);
    setStatus(response.data);
  };

  const connected = Boolean(status?.running && (status.companies?.length ?? 0) > 0);

  return (
    <div className="fv-standard-page">
      <PageHeader
        title="Connections"
        subtitle="TallyThis works from the files you upload. There is no login to your bank, marketplace or GST account."
      />

      <section className="fv-reveal mt-6 rounded-2xl border border-border bg-card p-5 sm:p-6" aria-label="Send to Tally">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--fv-soft)] text-[var(--fv-leaf)]">
            <Plug className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">Send to Tally</h2>
              <BrandLogo name="Tally" size="sm" />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Post reviewed vouchers straight into the company open in TallyPrime. This works when TallyThis runs on the same computer or
              network as Tally.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" className="fv-button-primary h-11" onClick={() => void check()} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {checking ? "Checking…" : status ? "Check again" : "Check connection"}
              </button>
              {connected && (
                <span className="text-sm font-medium text-emerald-800">
                  Connected · {status?.companies?.slice(0, 2).join(", ")}
                  {(status?.companies?.length ?? 0) > 2 ? ` and ${(status?.companies?.length ?? 0) - 2} more` : ""}
                </span>
              )}
            </div>

            {status && !connected && (
              <div className="mt-4">
                <Notice tone="warn">
                  <p className="font-medium">{status.message || "Tally did not answer."}</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
                    <li>Open TallyPrime and the company you want to post into.</li>
                    <li>Press F1 (Help) → Settings → Connectivity.</li>
                    <li>Set “TallyPrime acts as” to Server, with port 9000.</li>
                    <li>Come back and check again.</li>
                  </ol>
                </Notice>
              </div>
            )}
            {connected && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="fv-button-secondary" onClick={() => navigate("/app/jobs/bank-to-tally")}>
                  Convert a statement and send it
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              You can always download the Tally XML or Excel instead and import it yourself.
            </p>
          </div>
        </div>
      </section>

      <h2 className="mb-3 mt-9 text-lg font-semibold">What you can upload</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {SOURCES.map(source => (
          <article key={source.title} className="fv-reveal flex flex-col rounded-2xl border border-border bg-card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-semibold">{source.title}</h3>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{source.formats}</span>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{source.detail}</p>
            {source.logos.length > 0 && <LogoStrip className="is-compact !justify-start !mt-4" names={source.logos} size="sm" muted label={`${source.title} sources`} />}
            <div className="mt-auto pt-4">
              <button type="button" className="fv-button-secondary" onClick={() => navigate(source.job.href)}>
                Open {source.job.label}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-9 flex items-start gap-3 rounded-2xl border border-border bg-card p-5 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fv-leaf)]" />
        <p>
          Not connected today: bank accounts, the GST portal, marketplace seller accounts and Zoho Books’ own API. Each would need your
          authorisation, so nothing is read from them behind your back. Names and logos only say which kind of file you uploaded.
        </p>
      </div>
    </div>
  );
}
