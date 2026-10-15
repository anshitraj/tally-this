import { useEffect, useState } from "react";
import { DropZone, JobShell, Notice, Working, postFiles, takePendingFiles } from "@/components/jobs/jobUi";
import { GstSalesResult, type Gstr1Data, type ItcRun, type ThreeBData } from "@/components/jobs/GstSalesResult";

interface ReadResponse {
  runId: string | null;
  privacy?: boolean;
  file: string;
  gstr1: Gstr1Data;
  threeB: ThreeBData;
  itcRuns: ItcRun[];
  itcRunId: string | null;
}

type Stage = "idle" | "working" | "done" | "error";

const STEPS = ["Reading the sales register", "Sorting into GSTR-1 tables", "Preparing the GSTR-3B working"];

export default function GstSalesPage() {
  const [stage, setStage] = useState<Stage>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [data, setData] = useState<ReadResponse | null>(null);
  const [gstin, setGstin] = useState("");

  const read = async (chosen: File) => {
    setStage("working");
    setError("");
    const response = await postFiles<ReadResponse>("/api/jobs/gst-sales/read", { register: chosen, sellerGstin: gstin.trim() || undefined });
    if (!response.ok) {
      setError(response.data.message || "This register could not be read.");
      setStage("error");
      return;
    }
    setData(response.data);
    setStage("done");
  };

  useEffect(() => {
    const pending = takePendingFiles("gst-sales");
    if (!pending?.length) return;
    setFile(pending[0]);
    void read(pending[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setStage("idle");
    setFile(null);
    setData(null);
    setError("");
  };

  return (
    <JobShell
      title="Sales → GSTR-1 & 3B"
      outcome="Upload your sales register and get the GSTR-1 tables and a GSTR-3B working to check."
      modeLocked={stage !== "idle" && stage !== "error"}
    >
      {(stage === "idle" || stage === "error") && (
        <div className="space-y-4">
          {stage === "error" && <Notice tone="error">{error}</Notice>}
          <DropZone
            label="Sales register"
            hint="Excel or CSV. In TallyPrime: Display More Reports → Account Books → Sales Register → Export."
            files={file ? [file] : []}
            onFiles={files => {
              setFile(files[0]);
              if (files[0]) void read(files[0]);
            }}
          />
          <p className="text-center text-xs text-muted-foreground">We sort every sale into its GSTR-1 table and prove the tables add up to your register.</p>
          <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">More options</summary>
            <label className="mt-3 block text-xs font-semibold text-muted-foreground">
              Your GSTIN (optional)
              <input
                className="fv-input mt-1 h-10 w-full text-sm font-normal text-foreground sm:max-w-sm"
                value={gstin}
                onChange={event => setGstin(event.target.value.toUpperCase())}
                placeholder="27ABCDE1234F1Z5"
                maxLength={15}
              />
              <span className="mt-1 block font-normal">Used when the register prints no GSTIN above the table, to tell inter-state from intra-state sales.</span>
            </label>
          </details>
        </div>
      )}

      {stage === "working" && <Working steps={STEPS} />}

      {stage === "done" && data && (
        <>
          <GstSalesResult gstr1={data.gstr1} threeB={data.threeB} runId={data.runId} privacy={data.privacy} itcRuns={data.itcRuns} itcRunId={data.itcRunId} onReset={reset} />
          {data.privacy && (
            <div className="mt-4">
              <Notice tone="success">Incognito: this register and result are not saved to your workspace. Download before leaving.</Notice>
            </div>
          )}
        </>
      )}
    </JobShell>
  );
}
