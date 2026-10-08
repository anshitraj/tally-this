import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus } from "lucide-react";
import { Choice, Notice } from "@/components/jobs/jobUi";
import { AUTOMATIONS } from "@/pages/app/overview";
import { getActiveClient, setActiveClient } from "@/lib/activeClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Accounting = "Tally" | "Zoho" | "Other";

interface ClientSummary {
  companyId: number | null;
  linkId: number | null;
  name: string;
  source: string;
}

export default function ClientsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [accounting, setAccounting] = useState<Accounting>("Tally");
  const [open, setOpen] = useState(false);
  const active = getActiveClient();

  const { data, isLoading } = useQuery<{
    clients: ClientSummary[];
    source: string;
  }>({
    queryKey: ["practice-clients"],
    queryFn: () =>
      fetch(`${BASE}/api/practice/clients`).then((response) => response.json()),
  });

  const add = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${BASE}/api/practice/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok)
        throw new Error(body.error || "Could not add client");
      return body.client as { companyId: number; name: string; linkId: number };
    },
    onSuccess: (client) => {
      setActiveClient({
        id: client.companyId,
        name: client.name,
        accounting,
        linkId: client.linkId,
      });
      toast({
        title: "Client added",
        description: `Now working on ${client.name}.`,
      });
      setName("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["practice-clients"] });
    },
    onError: (error: Error) =>
      toast({
        title: "Client not added",
        description: error.message,
        variant: "destructive",
      }),
  });

  const start = (client: ClientSummary, href: string) => {
    if (!client.companyId || client.companyId < 0) return;
    setActiveClient({
      id: client.companyId,
      name: client.name,
      accounting: "Tally",
      linkId: client.linkId,
    });
    navigate(href);
  };

  const linked = (data?.clients ?? []).filter(
    (client) => (client.companyId ?? 0) > 0,
  );
  const sample = data?.source === "demo" && linked.length > 0;

  return (
    <div className="fv-standard-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Clients
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Each client keeps its own files and results.
          </p>
        </div>
        <button
          type="button"
          className="fv-button-primary h-11"
          onClick={() => setOpen((value) => !value)}
        >
          <Plus className="h-4 w-4" />
          Add client
        </button>
      </div>

      {sample && (
        <div className="mt-4">
          <Notice tone="warn">
            These are sample clients. Add a client to start real work.
          </Notice>
        </div>
      )}

      {open && (
        <form
          className="mt-5 rounded-2xl border border-border bg-card p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <label htmlFor="new-client" className="text-sm font-semibold">
            Business name
          </label>
          <input
            id="new-client"
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Sharma Traders"
            className="fv-input mt-2 h-12 w-full text-base"
          />
          <div className="mt-4 mb-2 text-sm font-semibold">
            Books are kept in
          </div>
          <Choice<Accounting>
            value={accounting}
            onChange={setAccounting}
            options={[
              { value: "Tally", label: "Tally" },
              { value: "Zoho", label: "Zoho Books" },
              { value: "Other", label: "Something else" },
            ]}
          />
          <div className="mt-5 flex gap-2">
            <button
              type="submit"
              className="fv-button-primary h-11"
              disabled={add.isPending || !name.trim()}
            >
              {add.isPending ? "Saving…" : "Save client"}
            </button>
            <button
              type="button"
              className="fv-button-ghost h-11"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="mt-6 space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading clients…</p>
        )}
        {linked.map((client) => {
          const isActive = active?.id === client.companyId;
          return (
            <article
              key={client.linkId ?? client.name}
              className={cn(
                "rounded-2xl border bg-card p-5",
                isActive ? "border-[var(--fv-accent)]/60" : "border-border",
              )}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Building2 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{client.name}</div>
                  {isActive && (
                    <div className="text-xs font-medium text-[var(--fv-accent-dark)]">
                      Working on this client
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="fv-button-secondary"
                  onClick={() => start(client, "/app/overview")}
                >
                  Open
                </button>
              </div>
              <details className="fv-client-jobs">
                <summary>Choose a job</summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {AUTOMATIONS.map((job) => (
                    <button
                      key={job.href}
                      type="button"
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:border-foreground/30"
                      onClick={() => start(client, job.href)}
                    >
                      {job.title}
                    </button>
                  ))}
                </div>
              </details>
            </article>
          );
        })}
        {linked.length === 0 && !isLoading && (
          <div className="rounded-2xl border border-dashed border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No clients yet. Add the first business you keep books for.
            </p>
            <button
              type="button"
              className="fv-button-primary mt-4"
              onClick={() => setOpen(true)}
            >
              <Plus className="h-4 w-4" />
              Add client
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
