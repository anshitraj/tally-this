import { ArrowRight, type LucideIcon } from "lucide-react";
import { useLocation } from "wouter";

export interface NextStep {
  label: string;
  hint: string;
  href: string;
  icon?: LucideIcon;
}

/**
 * Where to go next, in plain words. Every finished job ends here so the person is never left
 * asking "what do I click now?". Links only; nothing runs when it is shown.
 */
export function NextSteps({ steps, title = "What next?" }: { steps: NextStep[]; title?: string }) {
  const [, navigate] = useLocation();
  if (steps.length === 0) return null;
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {steps.map(step => {
          const Icon = step.icon ?? ArrowRight;
          return (
            <button
              key={step.href + step.label}
              type="button"
              onClick={() => navigate(step.href)}
              className="group flex items-start gap-3 rounded-xl border border-border px-3 py-2.5 text-left hover:border-[var(--fv-accent)] hover:bg-muted/40"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fv-accent-dark)]" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{step.label}</span>
                <span className="block text-xs text-muted-foreground">{step.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
