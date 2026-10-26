import { useEffect, useState } from "react";
import { AiConsentPrompt, DropZone, JobShell, Notice, Working, postFiles, takePendingFiles } from "@/components/jobs/jobUi";
import { BillsResult, type Bill } from "@/components/jobs/BillsResult";

interface ReadResponse {
  runId: string | null;
  privacy?: boolean;
  bills: Bill[];
  counts?: { pdf?: number; sheet?: number; ai?: number };
  notes?: string[];
  unreadable?: Array<{ fileName: string; reason: string }>;
  recipientGstin?: string | null;
  needsAiConsent?: boolean;
}

type Stage = "idle" | "working" | "consent" | "done" | "error";

const STEPS = ["Reading the bills", "Checking GSTIN and amounts", "Preparing Tally vouchers"];

export default function BillsTallyPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [data, setData] = useState<ReadResponse | null>(null);
  const [consent, setConsent] = useState("");
  const [gstin, setGstin] = useState("");

  const read = async (chosen: File[], allowAi = false) => {
    setStage("working");
    setError("");
    const response = await postFiles<ReadResponse>("/api/jobs/bills/read", {
      files: chosen,
      recipientGstin: gstin.trim() || undefined,
      allowAi: allowAi ? "1" : undefined,
    });
    if (!response.ok) {
      if (response.data.needsAiConsent) {
        setConsent(response.data.message ?? "");
        setStage("consent");
        return;
      }
      setError(response.data.message || "These bills could not be read.");
      setStage("error");
      return;
    }
    setData(response.data);
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("bills-tally");
    if (!pending?.length) return;
    setFiles(pending);
    void read(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (chosen: File[]) => {
    setFiles(chosen);
    if (chosen.length > 0) void read(chosen);
  };

  const reset = () => {
    setStage("idle");
    setFiles([]);
    setData(null);
    setError("");
  };

  return (
    <JobShell
      title="Bills → Tally"
      outcome="Upload purchase bills and get Tally purchase vouchers, with the GST split and supplier ledgers ready."
      modeLocked={stage !== "idle" && stage !== "error"}
    >
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            multiple
            label="Purchase bills"
            hint="Invoice PDFs, photos, or a purchase list (Excel/CSV). You can add many at once."
            files={files}
            onFiles={choose}
          />
          <p className="text-center text-xs text-muted-foreground">
            We read each bill, check the GSTIN and the totals, and show only what needs a look.
          </p>
          <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">More options</summary>
            <label className="mt-3 block text-xs font-semibold text-muted-foreground">
              This client's GSTIN (optional)
              <input
                className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground sm:max-w-sm"
                value={gstin}
                onChange={event => setGstin(event.target.value.toUpperCase())}
                placeholder="27ABCDE1234F1Z5"
                maxLength={15}
              />
              <span className="mt-1 block font-normal">Used to tell CGST + SGST from IGST when a bill prints only the total tax.</span>
            </label>
          </details>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "consent" && (
        <AiConsentPrompt
          fileName={files.length === 1 ? files[0].name : `${files.length} files`}
          message={consent}
          onAllow={() => read(files, true)}
          onCancel={reset}
        />
      )}

      {stage === "done" && data && (
        <BillsResult
          bills={data.bills}
          runId={data.runId}
          privacy={data.privacy}
          recipientGstin={data.recipientGstin ?? null}
          counts={data.counts}
          notes={data.notes}
          unreadable={data.unreadable}
          onReset={reset}
        />
      )}
      {stage === "done" && data?.privacy && (
        <div className="mt-4">
          <Notice tone="success">Incognito: these bills and the result are not saved to your workspace. Download before leaving.</Notice>
        </div>
      )}
    </JobShell>
  );
}
