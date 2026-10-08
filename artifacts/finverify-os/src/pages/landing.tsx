import { useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  FileCheck2,
  LockKeyhole,
  Menu,
  ShieldCheck,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/app/finverify-ui";
import { BankLogos } from "@/components/app/BankLogos";
import { DEMO_JOBS, ProductDemo } from "@/components/marketing/ProductDemo";
import { DropZone, setPendingFiles } from "@/components/jobs/jobUi";
import { getUser } from "@/lib/auth";
import { BRAND } from "@/lib/brand";

const SOLUTIONS = [
  {
    name: "Bank → Tally",
    title: "Your statement.\nYour Tally entries.",
    text: "Turn a bank statement into Tally vouchers. TallyThis reads the transactions, checks the running balance, and brings you the ledger choices that need a person.",
    points: [
      "Upload PDF, Excel or CSV statements",
      "Review the suggested Tally ledgers",
      "Download XML to import into Tally",
    ],
    href: "/app/jobs/bank-to-tally",
  },
  {
    name: "Bank ↔ Tally",
    title: "Find the differences.\nClose the gaps.",
    text: "Put your bank statement and Tally export side by side. Matched entries stay out of the way, so you can focus on missing entries and differences.",
    points: [
      "Upload a statement and Tally export",
      "Review only the entries that differ",
      "Export your reconciliation report",
    ],
    href: "/app/jobs/bank-tally",
  },
  {
    name: "E-commerce GST",
    title: "Marketplace reports.\nGST-ready data.",
    text: "Bring marketplace sales, returns and settlement reports into one clear view. Review the exceptions before preparing the data for your GST work.",
    points: [
      "Upload Amazon, Flipkart or Meesho reports",
      "Review sales, returns and GST details",
      "Export a summary or draft GST data",
    ],
    href: "/app/jobs/ecommerce-gst",
  },
  {
    name: "Invoice ↔ Bank",
    title: "Know what’s paid.\nSee what’s missing.",
    text: "Match your invoices to bank payments. Find invoices waiting for payment and transactions that still need a bill, without checking every row by hand.",
    points: [
      "Upload invoices and a bank statement",
      "Review unpaid or unmatched items",
      "Download a payment review report",
    ],
    href: "/app/jobs/invoice-bank",
  },
];
const FAQS = [
  [
    "Does TallyThis connect to my bank or Tally?",
    "The core jobs work with files you upload. Download your statement or export from your accounting software, upload it here, and import the resulting XML into Tally yourself. No bank login is required.",
  ],
  [
    "Do I need to set up an AI provider?",
    "No. File parsing and financial checks use deterministic rules. Optional document-reading assistance can help with scans, but your review and the source data remain authoritative.",
  ],
  [
    "Will it file GST returns for me?",
    "No. TallyThis prepares reports and draft data for review. A CA or accountant should check the result before filing or importing it into the books.",
  ],
  [
    "Can I work with more than one client?",
    "Yes. Select the client before choosing a job. Files, results and activity are scoped to that client, and saved jobs can be reopened from your history.",
  ],
];
const TRUST = [
  {
    icon: LockKeyhole,
    title: "A workspace for each client",
    text: "Files and results are scoped to the client you select.",
  },
  {
    icon: FileCheck2,
    title: "Rules check the numbers",
    text: "Matching and financial checks use deterministic rules. Optional AI helps read documents.",
  },
  {
    icon: ShieldCheck,
    title: "A clear trail of your work",
    text: "Saved jobs, review decisions and activity help you pick up where you left off.",
  },
];

export default function LandingPage() {
  const [, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [solution, setSolution] = useState(0);
  const signedIn = Boolean(getUser());
  const start = (href = "/app/overview") =>
    navigate(signedIn ? href : "/login?mode=signup");
  const scrollTo = (id: string) => {
    setMenuOpen(false);
    document
      .getElementById(id)
      ?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
  };
  const tryFile = (files: File[]) => {
    setPendingFiles("bank-to-tally", files);
    start("/app/jobs/bank-to-tally");
  };
  const selected = SOLUTIONS[solution];

  return (
    <div className="fv-marketing">
      <a href="#main-content" className="fv-skip-link">
        Skip to content
      </a>
      <header className="fv-site-header">
        <div className="fv-site-container fv-site-nav">
          <button
            type="button"
            aria-label="TallyThis home"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <BrandMark />
          </button>
          <nav aria-label="Main navigation" className="fv-desktop-nav">
            <button type="button" onClick={() => scrollTo("solutions")}>
              Solutions
            </button>
            <button type="button" onClick={() => scrollTo("how")}>
              How it works
            </button>
            <button type="button" onClick={() => scrollTo("security")}>
              Your data
            </button>
          </nav>
          <div className="fv-nav-actions">
            <button
              className="fv-sign-in"
              type="button"
              onClick={() => navigate(signedIn ? "/app/overview" : "/login")}
            >
              {signedIn ? "Open workspace" : "Sign in"}
            </button>
            <button
              className="fv-site-button"
              type="button"
              onClick={() => start()}
            >
              Get started <ArrowUpRight size={15} />
            </button>
          </div>
          <button
            type="button"
            className="fv-mobile-menu"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
        {menuOpen && (
          <nav className="fv-mobile-nav" aria-label="Mobile navigation">
            {[
              ["solutions", "Solutions"],
              ["how", "How it works"],
              ["security", "Your data"],
            ].map(([id, name]) => (
              <button type="button" key={id} onClick={() => scrollTo(id)}>
                {name}
                <ArrowUpRight size={16} />
              </button>
            ))}
            <button
              type="button"
              onClick={() => navigate(signedIn ? "/app/overview" : "/login")}
            >
              Sign in
              <ArrowUpRight size={16} />
            </button>
            <button
              type="button"
              className="fv-site-button"
              onClick={() => start()}
            >
              Get started
              <ArrowRight size={16} />
            </button>
          </nav>
        )}
      </header>
      <main id="main-content">
        <section className="fv-hero">
          <div className="fv-site-container fv-hero-grid">
            <div className="fv-hero-copy">
              <span className="fv-hero-eyebrow">
                <span />
                FOR THE PEOPLE BEHIND THE BOOKS
              </span>
              <h1>
                Less entry.
                <br />
                More clarity.
                <br />
                <span>Books, in order.</span>
              </h1>
              <p>
                Bank statements to Tally. Marketplace reports to GST. Bring your
                files; leave with checked entries and a clear next step.
              </p>
              <div className="fv-hero-actions">
                <button
                  type="button"
                  className="fv-site-button is-light"
                  onClick={() => start()}
                >
                  Start your first job <ArrowUpRight size={18} />
                </button>
                <button
                  type="button"
                  className="fv-hero-watch"
                  onClick={() => scrollTo("solutions")}
                >
                  See it in action <ArrowRight size={17} />
                </button>
              </div>
              <div className="fv-hero-note">
                <Check size={14} />
                Upload-based. No bank login. You stay in control.
              </div>
            </div>
            <div className="fv-hero-visual">
              <div className="fv-hero-grid-lines" aria-hidden="true" />
              <ProductDemo hero />
            </div>
          </div>
          <div className="fv-hero-baseline fv-site-container">
            <span>BUILT FOR INDIAN CAs, ACCOUNTANTS & FINANCE TEAMS</span>
            <button type="button" onClick={() => scrollTo("banks")}>
              Good work starts with your files
              <ChevronDown size={14} />
            </button>
          </div>
        </section>
        <section id="banks" className="fv-source-section">
          <div className="fv-site-container">
            <p className="fv-micro">BRING THE STATEMENTS YOU ALREADY HAVE</p>
            <BankLogos />
            <p className="fv-source-note">
              Bank statement uploads, not connected bank accounts. Logos belong
              to their respective owners.
            </p>
          </div>
        </section>
        <section className="fv-problem-section">
          <div className="fv-site-container">
            <div className="fv-section-heading">
              <span className="fv-micro">THE WORK BEFORE THE REAL WORK</span>
              <h2>
                Month-end shouldn’t mean
                <br />
                <span>starting from scratch.</span>
              </h2>
            </div>
            <div className="fv-problem-grid">
              {[
                [
                  "01",
                  "Files everywhere.",
                  "Statements, invoices and reports arrive in different formats. Getting them into your books takes time.",
                ],
                [
                  "02",
                  "The same entry, again.",
                  "Manually copying amounts and picking ledgers leaves less time for the work that needs your judgement.",
                ],
                [
                  "03",
                  "Every row gets a look.",
                  "The entries that need attention get buried among the ones that already match.",
                ],
              ].map(([number, title, text]) => (
                <article key={number}>
                  <span className="fv-micro">{number}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section id="solutions" className="fv-solutions-section">
          <div className="fv-site-container">
            <div className="fv-section-heading fv-solutions-heading">
              <div>
                <span className="fv-micro">
                  FOUR JOBS. ONE SIMPLE WAY TO WORK.
                </span>
                <h2>
                  From a pile of files
                  <br />
                  to <span>a clear next step.</span>
                </h2>
              </div>
              <p>
                Choose the job. Upload your files.
                <br />
                Review the exceptions. Export the result.
              </p>
            </div>
            <div
              className="fv-solution-tabs"
              role="tablist"
              aria-label="Accounting jobs"
            >
              {SOLUTIONS.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  role="tab"
                  aria-selected={solution === index}
                  aria-controls="solution-panel"
                  id={`solution-tab-${index}`}
                  tabIndex={solution === index ? 0 : -1}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "ArrowRight"
                        ? (index + 1) % 4
                        : event.key === "ArrowLeft"
                          ? (index + 3) % 4
                          : event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? 3
                              : null;
                    if (next !== null) {
                      event.preventDefault();
                      setSolution(next);
                      document.getElementById(`solution-tab-${next}`)?.focus();
                    }
                  }}
                  onClick={() => setSolution(index)}
                >
                  <span className="fv-micro">0{index + 1}</span>
                  {item.name}
                </button>
              ))}
            </div>
            <div
              id="solution-panel"
              role="tabpanel"
              aria-labelledby={`solution-tab-${solution}`}
              className="fv-solution-panel"
            >
              <div className="fv-solution-copy" key={`copy-${solution}`}>
                <span className="fv-micro">{selected.name}</span>
                <h3>
                  {selected.title.split("\n").map((line) => (
                    <span key={line}>
                      {line}
                      <br />
                    </span>
                  ))}
                </h3>
                <p>{selected.text}</p>
                <ul>
                  {selected.points.map((point) => (
                    <li key={point}>
                      <Check size={15} />
                      {point}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="fv-text-link"
                  onClick={() => start(selected.href)}
                >
                  Start this job
                  <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="fv-solution-preview">
                <ProductDemo key={solution} job={solution} />
                <p>{DEMO_JOBS[solution].description}</p>
              </div>
            </div>
          </div>
        </section>
        <section id="how" className="fv-how-section">
          <div className="fv-site-container">
            <div className="fv-section-heading">
              <span className="fv-micro">NO MANUAL REQUIRED</span>
              <h2>
                A familiar flow.
                <br />
                <span>A lot less busywork.</span>
              </h2>
            </div>
            <div
              className="fv-journey"
              aria-label="Select client, choose job, upload, review, export"
            >
              {[
                "Select client",
                "Choose job",
                "Upload",
                "Review",
                "Export",
              ].map((name, index) => (
                <div key={name}>
                  <span>0{index + 1}</span>
                  <strong>{name}</strong>
                  {index < 4 && <ArrowRight size={18} />}
                </div>
              ))}
            </div>
            <div className="fv-how-grid">
              <article>
                <div
                  className="fv-mini-scene fv-mini-upload"
                  aria-hidden="true"
                >
                  <div className="fv-mini-document">
                    <FileCheck2 size={26} />
                    <b>statement.pdf</b>
                    <span>Ready to upload</span>
                  </div>
                  <div className="fv-mini-tags">
                    <span>PDF</span>
                    <span>EXCEL</span>
                    <span>CSV</span>
                  </div>
                </div>
                <span className="fv-micro">01 / BRING YOUR FILES</span>
                <h3>Start with what you have.</h3>
                <p>
                  Select your client and job, then upload the file your bank,
                  marketplace or accounting software gives you.
                </p>
              </article>
              <article>
                <div
                  className="fv-mini-scene fv-mini-review"
                  aria-hidden="true"
                >
                  <div>
                    <CheckCircle2 size={15} />
                    <span>Entries that match</span>
                    <b>Out of your way</b>
                  </div>
                  <div className="fv-mini-attention">
                    <span className="fv-attention-dot" />
                    <span>Items that need a decision</span>
                    <ArrowRight size={16} />
                  </div>
                  <div>
                    <CheckCircle2 size={15} />
                    <span>Your judgement</span>
                    <b>Always in control</b>
                  </div>
                </div>
                <span className="fv-micro">02 / REVIEW THE EXCEPTIONS</span>
                <h3>Only the work that needs you.</h3>
                <p>
                  Make clear choices on uncertain entries. The source and more
                  details are there whenever you need them.
                </p>
              </article>
              <article>
                <div
                  className="fv-mini-scene fv-mini-export"
                  aria-hidden="true"
                >
                  <div className="fv-export-icon">
                    <Check size={29} />
                  </div>
                  <strong>Ready for your next step.</strong>
                  <span>Tally XML · CSV reports · GST drafts</span>
                  <div className="fv-export-line">
                    <i />
                  </div>
                </div>
                <span className="fv-micro">03 / TAKE THE RESULT</span>
                <h3>Useful output. Ready to go.</h3>
                <p>
                  Download your file, import it into Tally or send the report
                  for CA review. Reopen saved jobs from your history.
                </p>
              </article>
            </div>
          </div>
        </section>
        <section id="demo" className="fv-try-section">
          <div className="fv-site-container fv-try-grid">
            <div>
              <span className="fv-micro">
                YOUR NEXT STATEMENT IS A GOOD START
              </span>
              <h2>
                Less explaining.
                <br />
                <span>More doing.</span>
              </h2>
              <p>
                Choose a bank statement. Sign in or create an account, and
                continue with your file in Bank → Tally.
              </p>
            </div>
            <DropZone
              label="Upload your bank statement"
              hint="PDF, Excel, CSV or photo · sign in to process"
              onFiles={tryFile}
            />
          </div>
        </section>
        <section id="security" className="fv-trust-section">
          <div className="fv-site-container fv-trust-grid">
            <div>
              <ShieldCheck size={30} strokeWidth={1.4} />
              <span className="fv-micro">CONFIDENCE COMES FROM THE SOURCE</span>
              <h2>
                Your clients’ books.
                <br />
                <span>Your judgement.</span>
              </h2>
              <p>
                TallyThis helps prepare and check the data. You make the
                accounting decisions, with the original entries available for
                review.
              </p>
            </div>
            <div className="fv-trust-list">
              {TRUST.map(({ icon: Icon, title, text }) => (
                <article key={title}>
                  <Icon size={20} />
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
        <section className="fv-faq-section">
          <div className="fv-site-container fv-faq-grid">
            <div>
              <span className="fv-micro">A FEW THINGS TO KNOW</span>
              <h2>
                Clear from
                <br />
                the start.
              </h2>
            </div>
            <div>
              {FAQS.map(([question, answer]) => (
                <details key={question}>
                  <summary>
                    {question}
                    <ChevronDown size={17} />
                  </summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
        <section className="fv-closing-section">
          <div className="fv-site-container fv-closing-grid">
            <div>
              <span className="fv-micro">
                MAKE ROOM FOR THE WORK THAT MATTERS
              </span>
              <h2>
                Give the busywork
                <br />
                <em>less of your day.</em>
              </h2>
              <button
                type="button"
                className="fv-site-button is-light"
                onClick={() => start()}
              >
                Start your first job
                <ArrowUpRight size={17} />
              </button>
            </div>
            <div className="fv-closing-definition">
              <span>tally this</span>
              <i>verb</i>
              <p>
                Bring clarity to the numbers.
                <br />
                Move forward with confidence.
              </p>
              <small>Upload. Review. Export.</small>
            </div>
          </div>
        </section>
      </main>
      <footer className="fv-site-footer">
        <div className="fv-site-container">
          <div className="fv-footer-top">
            <div>
              <BrandMark light />
              <p>
                Accounting automation.
                <br />
                Built around the way you work.
              </p>
              <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>
            </div>
            <div>
              <span className="fv-micro">THE PRODUCT</span>
              <button type="button" onClick={() => scrollTo("solutions")}>
                Explore the jobs
              </button>
              <button type="button" onClick={() => scrollTo("how")}>
                How it works
              </button>
            </div>
            <div>
              <span className="fv-micro">GET STARTED</span>
              <button type="button" onClick={() => start()}>
                Open your workspace
                <ArrowUpRight size={13} />
              </button>
              <button type="button" onClick={() => navigate("/login")}>
                Sign in
              </button>
            </div>
          </div>
          <div className="fv-footer-bottom">
            <span>© {new Date().getFullYear()} TallyThis</span>
            <span>Prepared for review. Always checked by you.</span>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            >
              Back to top ↑
            </button>
          </div>
          <div className="fv-footer-wordart" aria-hidden="true">
            tallythis.
          </div>
        </div>
      </footer>
    </div>
  );
}
