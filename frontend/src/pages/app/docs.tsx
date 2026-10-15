import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { BRAND } from "@/lib/brand";

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-8 rounded-2xl border border-border bg-card p-5">
    <h2 className="mb-3 text-base font-bold text-foreground">{title}</h2>
    <div className="space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
  </section>
);

export default function DocsPage() {
  return (
    <PageTransition className="mx-auto max-w-4xl">
      <PageHeader
        title="TallyThis documentation"
        subtitle="Upload. Verify. Export. Accounting automation for CAs, accountants, and finance teams."
      />

      <Section title="What you can do">
        <p>Bank Statement → Tally reads a statement and builds receipt and payment vouchers. Bank ↔ Tally compares one bank file with one Tally export and works out a bank reconciliation statement. E-commerce GST normalizes marketplace CSVs into a draft pack. Invoice ↔ Bank suggests payment matches for review. GSTR-2B ↔ Books compares the GST portal's GSTR-2B with your purchase register.</p>
        <p>The current product is upload-based. Direct Tally, GST portal, and bank connections are not live. A local Tally connector exists for customers who run Tally on their own machine.</p>
      </Section>

      <Section title="GSTR-2B ↔ Books">
        <p>Upload GSTR-2B (JSON or Excel from the GST portal; several months can be added together) and your purchase register (Excel or CSV from Tally or any billing software). Documents are matched by supplier GSTIN and invoice number. A match needs both to agree and the amounts to agree within ₹1; anything found by a looser rule, such as a different invoice number or a different GSTIN, is only suggested until you confirm it.</p>
        <p>The result lists what is in your books but not in GSTR-2B (ITC not supported), what is in GSTR-2B but not in your books, amount differences, documents entered twice, and documents GSTR-2B itself marks as ITC not available. Each supplier with missing invoices gets a message you can copy or email. The Excel file has the summary by tax head, every list and a vendor-wise sheet.</p>
        <p>This compares two files. It does not file anything, does not decide whether ITC may be claimed, and is not a GST portal check. Potential risk — needs CA review.</p>
      </Section>

      <Section title="Reconciliation statement and the month pack">
        <p>After Bank ↔ Tally, the reconciliation statement starts from the bank's closing balance and adds or subtracts the entries that differ to reach the balance as per books. Type in the Tally ledger balance to see whether it adds up. Entries missing in Tally can be downloaded as vouchers to import.</p>
        <p>Reports builds one Excel file for a client and month from the jobs saved in TallyThis: what was done, and every item that still needs a decision. Incognito jobs are never saved, so they are never in it.</p>
      </Section>

      <Section title="Finding your way">
        <p>Press Ctrl K (or ⌘K) anywhere to search jobs, pages and clients. The menu keeps the four everyday jobs on top and everything else under Advanced, grouped by purpose. If a session ends you are sent to sign in and brought back to the same page.</p>
      </Section>

      <Section title="Runs">
        <p>Every job creates a run. Reports and review decisions belong to that run. Client workspaces remember which business you selected. Financial queries stay inside the signed-in company.</p>
      </Section>

      <div className="fv-status-review mb-8 rounded-2xl border p-4 text-sm leading-6">
        TallyThis is upload-first. A local Tally connector is available on Tax Audit for customer-run Tally gateways; direct bank, GST, payroll, and gateway API integrations remain future work unless a page explicitly proves otherwise. AI extracted data is pending review. Rules match. Humans approve. CA reviews.
      </div>

      <Section title="Normal Upload vs Advanced Upload">
        <p>The Normal Upload page stays simple. After upload it only shows file name, detected source type, status, the Smart Next Step panel, Action History, and Upload History.</p>
        <p>The Advanced Upload View is hidden by default. Click <span className="font-semibold text-foreground">Open Advanced Upload View</span> to see parsed rows, extracted PDF text, detected columns, mapping preview, import preview, AI extraction details, parsing warnings, and reprocess options.</p>
      </Section>

      <Section title="Upload vs Parsing vs Import vs Reconciliation vs Report">
        <ul className="list-disc space-y-1 pl-5">
          <li><span className="font-semibold text-foreground">Upload</span> means file received.</li>
          <li><span className="font-semibold text-foreground">Parsing</span> means file understood — rows, columns, or text extracted.</li>
          <li><span className="font-semibold text-foreground">Import</span> means records saved into bank, invoice, ledger, payroll, GST, or gateway tables.</li>
          <li><span className="font-semibold text-foreground">Reconciliation / Review</span> means records compared across sources.</li>
          <li><span className="font-semibold text-foreground">Report</span> means CA-ready output with matched, unmatched, missing, duplicate, and CA-attention items.</li>
        </ul>
      </Section>

      <Section title="What Happens After Upload?">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Upload files for the current month.</li>
          <li>The app parses files and records file metadata.</li>
          <li>Smart Next Step detects available workflows from uploaded sources.</li>
          <li>You import selected records into financial tables.</li>
          <li>You choose the comparison or review type to run.</li>
          <li>The app generates reports, exceptions, and review items.</li>
          <li>CA reviews unresolved items before final reporting.</li>
        </ol>
      </Section>

      <Section title="You Do Not Need Every File">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["Bank + Tally", "Ledger reconciliation"],
            ["Bank + Invoices", "Payment reconciliation"],
            ["Bank + Gateway", "Settlement reconciliation"],
            ["Bank + Payroll", "Payroll matching"],
            ["GST/TDS only", "GST/TDS review pack"],
            ["Expenses only", "Expense review and missing receipt checks"],
          ].map(([sources, result]) => (
            <div key={sources} className="rounded-xl border border-border bg-background p-4">
              <div className="text-sm font-semibold text-foreground">{sources}</div>
              <div className="mt-1 text-xs text-muted-foreground">{result}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="What Does Reconciliation Do?">
        <p>Reconciliation compares records from different sources to find matches, mismatches, missing documents, duplicate invoices, and items that need CA review.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Bank to Invoices: checks whether payments match accepted invoices.</li>
          <li>Bank to Tally: checks whether bank entries match ledger entries.</li>
          <li>Bank to Payroll: checks whether salary payments match payroll sheets.</li>
          <li>Bank to Gateway: checks whether settlement credits match payment gateway reports.</li>
        </ul>
        <p className="mt-2">TallyThis never auto-decides truth. Every potential similarity becomes a <span className="font-semibold text-foreground">suggested match</span>. The CA reviews each one and marks <span className="font-semibold text-foreground">Correct</span>, <span className="font-semibold text-foreground">Wrong</span>, or <span className="font-semibold text-foreground">Needs more info</span>. After all matches are reviewed, click <span className="font-semibold text-foreground">Generate CA-ready Report</span> on the Reconciliation page to finalize.</p>
      </Section>

      <Section title="GST/TDS Wording">
        <p>GST/TDS uploads do not run reconciliation. They generate a <span className="font-semibold text-foreground">GST/TDS Review Pack</span> with the language <span className="italic">Potential risk — needs CA review.</span> TallyThis never claims legal, tax, or audit certainty.</p>
      </Section>

      <Section title="Reports and Exports">
        <p>Every workflow produces a report with: summary, matched items, possible matches, unmatched items, missing documents, duplicates, amount / date / name mismatches, CA attention items, source evidence, and suggested actions. Exports: JSON, CSV, Excel, and printable PDF/HTML where supported.</p>
      </Section>

      <Section title="Action History vs Upload History">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Action History</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Workflow actions such as upload parsed, records imported, reconciliation run, AI extraction reviewed, GST/TDS pack generated, and export created.</p>
          </div>
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="text-sm font-semibold text-foreground">Upload History</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Immutable file audit trail showing what was uploaded, source type, file status, upload date, and compact metadata.</p>
          </div>
        </div>
      </Section>

      <Section title="AI and Compliance Language">
        <ul className="list-disc space-y-1 pl-5">
          <li>Use “AI extracted — pending review” for AI extraction results.</li>
          <li>Use “Potential risk — needs CA review” for compliance review items.</li>
          <li>Never treat AI as the financial source of truth.</li>
          <li>Never claim legal, tax, GST, TDS, audit, or fraud certainty.</li>
        </ul>
      </Section>

      <Section title="What Is Real Now">
        <ul className="list-disc space-y-1 pl-5">
          <li>Upload-based file capture and parsing for supported CSV, Excel, PDF, and image files.</li>
          <li>Local Tally connector for pulling a Tally Day Book into tax-audit tables and reconciliation ledger entries when Tally is reachable from the API host.</li>
          <li>Selected-source import into bank transactions, invoices, ledger entries, GST/TDS records, payroll entries, and gateway settlements.</li>
          <li>Rule-based reconciliation and matching flows.</li>
          <li>Action history and immutable upload history.</li>
          <li>CA review, reports, and exports based on available uploaded records.</li>
        </ul>
      </Section>
      <Section title="Contact">
        <p>Questions about your workspace or an export? Email <a className="font-semibold text-primary underline underline-offset-4" href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a>.</p>
      </Section>
    </PageTransition>
  );
}
