import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = {
  upload: [
    "Uploading file...",
    "Checking file type...",
    "Saving file metadata...",
    "Parsing document...",
    "Detecting rows and columns...",
    "Preparing next steps...",
  ],
  import: [
    "Reading parsed data...",
    "Mapping records...",
    "Creating source records...",
    "Saving evidence links...",
    "Updating action history...",
  ],
  reconciliation: [
    "Checking available sources...",
    "Comparing bank records...",
    "Matching invoices and ledger entries...",
    "Detecting missing documents...",
    "Creating exceptions...",
    "Saving reconciliation report...",
  ],
  ai: [
    "Reading invoice text...",
    "Extracting invoice fields...",
    "Validating structured output...",
    "Checking confidence and source quotes...",
    "Saving as pending review...",
  ],
} as const;

type ProcessingKind = keyof typeof STEPS;

export default function ProcessingSteps({
  kind,
  active,
  currentStep,
  title,
}: {
  kind: ProcessingKind;
  active: boolean;
  currentStep?: number;
  title?: string;
}) {
  const [optimisticStep, setOptimisticStep] = useState(0);

  useEffect(() => {
    if (!active || currentStep !== undefined) return;
    setOptimisticStep(0);
    const timer = window.setInterval(() => {
      setOptimisticStep(current => Math.min(current + 1, STEPS[kind].length - 1));
    }, 650);
    return () => window.clearInterval(timer);
  }, [active, currentStep, kind]);

  if (!active) return null;
  const steps = STEPS[kind];
  const progress = currentStep ?? optimisticStep;

  return (
    <div className="fv-card-flat mb-5 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        {title ?? "Working..."}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((step, index) => (
          <div
            key={step}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
              index < progress && "border-success/25 bg-success/5 text-success",
              index === progress && "border-primary/25 bg-primary/5 text-primary",
              index > progress && "border-border bg-muted/30 text-muted-foreground",
            )}
          >
            {index < progress ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 rounded-full border border-current" />}
            <span>{step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
