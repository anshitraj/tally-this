import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Choice, refreshClients } from "@/components/jobs/jobUi";
import EmptyPanel from "@/components/app/EmptyPanel";
import { BrandLogo } from "@/components/app/BrandLogo";
import { AUTOMATIONS } from "@/pages/app/overview";
import { GST_RECON_JOB } from "@/lib/navigation";
import { getActiveClient, setActiveClient } from "@/lib/activeClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { readJson } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Accounting = "Tally" | "Zoho" | "Other";

interface ClientSummary {
  companyId: number | null;
  linkId: number | null;
  name: string;
  source: string;
}

async function send(path: string, method: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || data.message || "That did not work. Please try again.");
  return data;
}

export default function ClientsPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [accounting, setAccounting] = useState<Accounting>("Tally");
  const [open, setOpen] = useState(() => new URLSearchParams(search).get("add") === "1");
  const [find, setFind] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const active = getActiveClient();

  // "Add a client" from the search box lands here with the form already open.
  useEffect(() => {
    if (new URLSearchParams(search).get("add") === "1") setOpen(true);
  }, [search]);

  const { data, isLoading, isError, refetch } = useQuery<{ clients: ClientSummary[]; source: string }>({
    // Its own key: the practice console caches a much larger reply under "practice-clients".
    queryKey: ["practice-clients-light"],
    queryFn: () => fetch(`${BASE}/api/practice/clients?light=1`).then(readJson),
  });

  const changed = () => {
    void qc.invalidateQueries({ queryKey: ["practice-clients-light"] });
    void qc.invalidateQueries({ queryKey: ["practice-clients"] });
    void refreshClients();
  };

  const add = useMutation({
    mutationFn: async () => {
      const body = await send("/api/practice/clients", "POST", { name: name.trim() });
      return body.client as { companyId: number; name: string; linkId: number };
    },
    onSuccess: client => {
      setActiveClient({ id: client.companyId, name: client.name, accounting, linkId: client.linkId });
      toast({ title: "Client added", description: `Now working on ${client.name}.` });
      setName("");
      setOpen(false);
      changed();
    },
    onError: (error: Error) => toast({ title: "Client not added", description: error.message, variant: "destructive" }),
  });

  const rename = useMutation({
    mutationFn: async (input: { linkId: number; name: string }) => send(`/api/practice/clients/${input.linkId}`, "PATCH", { name: input.name }),
    onSuccess: (_data, input) => {
      if (active?.linkId === input.linkId) setActiveClient({ ...active, name: input.name });
      setRenaming(null);
      toast({ title: "Name updated" });
      changed();
    },
    onError: (error: Error) => toast({ title: "Name not changed", description: error.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (linkId: number) => send(`/api/practice/clients/${linkId}`, "DELETE"),
    onSuccess: (_data, linkId) => {
      if (active?.linkId === linkId) localStorage.removeItem("finverify_active_client");
      setRemoving(null);
      toast({ title: "Client removed from your list", description: "Their files and results are kept." });
      changed();
    },
    onError: (error: Error) => toast({ title: "Client not removed", description: error.message, variant: "destructive" }),
  });

  const start = (client: ClientSummary, href: string) => {
    if (!client.companyId || client.companyId < 0) return;
    setActiveClient({ id: client.companyId, name: client.name, accounting: "Tally", linkId: client.linkId });
    navigate(href);
  };

  const linked = useMemo(() => (data?.clients ?? []).filter(client => (client.companyId ?? 0) > 0), [data]);
  const shown = useMemo(() => {
    const needle = find.trim().toLowerCase();
    return needle ? linked.filter(client => client.name.toLowerCase().includes(needle)) : linked;
  }, [linked, find]);

  const jobs = [...AUTOMATIONS, { id: "gstr-2b", title: "GSTR-2B ↔ Books", href: GST_RECON_JOB.href }];

  return (
    <div className="fv-standard-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Clients</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Each client keeps its own files and results.</p>
        </div>
        <button type="button" className="fv-button-primary h-11" onClick={() => setOpen(value => !value)}>
          <Plus className="h-4 w-4" />
          Add client
        </button>
      </div>

      {open && (
        <form
          className="fv-reveal mt-5 rounded-2xl border border-border bg-card p-5"
          onSubmit={event => {
            event.preventDefault();
            if (name.trim() && !add.isPending) add.mutate();
          }}
        >
          <label htmlFor="new-client" className="text-sm font-semibold">
            Business name
          </label>
          <input
            id="new-client"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="e.g. Sharma Traders"
            className="fv-input mt-2 h-12 w-full text-base"
          />
          <p className="mt-2 text-xs text-muted-foreground">That is all we need. GSTIN and other details are asked only when a job needs them.</p>
          <div className="mb-2 mt-4 text-sm font-semibold">Books are kept in</div>
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
            <button type="submit" className="fv-button-primary h-11" disabled={add.isPending || !name.trim()}>
              {add.isPending ? "Saving…" : "Save client"}
            </button>
            <button type="button" className="fv-button-ghost h-11" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {linked.length > 5 && (
        <label className="relative mt-5 block">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Find a client"
            value={find}
            onChange={event => setFind(event.target.value)}
            placeholder={`Find among ${linked.length} clients`}
            className="fv-input h-11 w-full pl-10"
          />
        </label>
      )}

      <div className="mt-6 space-y-3">
        {isLoading && [0, 1, 2].map(i => <div key={i} className="fv-skeleton h-[88px]" aria-hidden="true" />)}

        {isError && !isLoading && (
          <EmptyPanel
            title="Your clients could not be loaded."
            actions={
              <button type="button" className="fv-button-primary" onClick={() => void refetch()}>
                Try again
              </button>
            }
          >
            Check your connection and try once more.
          </EmptyPanel>
        )}

        {shown.map(client => {
          const isActive = active?.id === client.companyId;
          const isRenaming = renaming === client.linkId;
          const isRemoving = removing === client.linkId;
          return (
            <article
              key={client.linkId ?? client.name}
              className={cn(
                "fv-reveal rounded-2xl border bg-card p-5 transition-colors",
                isActive ? "border-[var(--fv-leaf)]" : "border-border",
              )}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Building2 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  {isRenaming ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={event => {
                        event.preventDefault();
                        if (draft.trim() && client.linkId) rename.mutate({ linkId: client.linkId, name: draft.trim() });
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Client name"
                        maxLength={120}
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        className="fv-input h-10 min-w-0 flex-1"
                      />
                      <button type="submit" className="fv-button-primary h-10 px-3" disabled={rename.isPending} aria-label="Save name">
                        <Check className="h-4 w-4" />
                      </button>
                      <button type="button" className="fv-button-ghost h-10 px-3" onClick={() => setRenaming(null)} aria-label="Cancel rename">
                        <X className="h-4 w-4" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="truncate font-semibold">{client.name}</div>
                      {isActive && <div className="text-xs font-medium text-[var(--fv-leaf)]">Working on this client</div>}
                    </>
                  )}
                </div>
                {!isRenaming && (
                  <>
                    <button type="button" className="fv-button-secondary" onClick={() => start(client, "/app/overview")}>
                      Open
                    </button>
                    {client.linkId && (
                      <div className="flex items-center">
                        <button
                          type="button"
                          className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Rename ${client.name}`}
                          title="Rename"
                          onClick={() => {
                            setRenaming(client.linkId);
                            setDraft(client.name);
                            setRemoving(null);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-red-700"
                          aria-label={`Remove ${client.name}`}
                          title="Remove from my list"
                          onClick={() => setRemoving(client.linkId)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {isRemoving && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
                  <span className="min-w-0 flex-1">
                    Remove {client.name} from your list? Their files and results are kept; you can add the client again.
                  </span>
                  <button
                    type="button"
                    className="fv-button-secondary"
                    disabled={remove.isPending}
                    onClick={() => client.linkId && remove.mutate(client.linkId)}
                  >
                    {remove.isPending ? "Removing…" : "Yes, remove"}
                  </button>
                  <button type="button" className="fv-button-ghost" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </div>
              )}

              <details className="fv-client-jobs">
                <summary>Choose a job</summary>
                <div className="mt-3 flex flex-wrap gap-2">
                  {jobs.map(job => (
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

        {!isLoading && !isError && linked.length > 0 && shown.length === 0 && (
          <EmptyPanel
            title="No client matches that."
            actions={
              <button type="button" className="fv-button-secondary" onClick={() => setFind("")}>
                Clear search
              </button>
            }
          />
        )}

        {!isLoading && !isError && linked.length === 0 && (
          <EmptyPanel
            icon={Building2}
            title="Add the first business you keep books for."
            actions={
              <button type="button" className="fv-button-primary" onClick={() => setOpen(true)}>
                <Plus className="h-4 w-4" />
                Add client
              </button>
            }
          >
            Files and results stay separate for each client, so nothing gets mixed up.
          </EmptyPanel>
        )}
      </div>

      {linked.length > 0 && (
        <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <span>Books kept in</span>
          <BrandLogo name="Tally" size="sm" muted />
          <BrandLogo name="Zoho Books" size="sm" muted />
        </p>
      )}
    </div>
  );
}
