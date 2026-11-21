import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowRight, ShoppingBag, Zap } from "lucide-react";
import EmptyPanel from "@/components/app/EmptyPanel";
import { MarketplaceCard } from "@/components/ecommerce/MarketplaceCard";
import { setPendingFiles } from "@/components/jobs/jobUi";
import { api, type MarketplaceInfo } from "@/lib/ecommerce";

/** The E-commerce page: one card per marketplace, each opening its own workspace. */
export default function EcommerceHubPage() {
  const [, navigate] = useLocation();
  const { data, isLoading, isError, refetch } = useQuery<{ marketplaces: MarketplaceInfo[] }>({
    queryKey: ["ecommerce", "marketplaces"],
    queryFn: () => api("/ecommerce/marketplaces"),
  });
  const list = data?.marketplaces ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="max-w-2xl">
        <h1 className="text-balance text-2xl font-semibold">E-commerce</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Import your marketplace reports and reconcile sales, returns and GST before CA review.
        </p>
      </header>

      {isLoading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading marketplaces">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-56 animate-pulse rounded-2xl border border-border bg-muted/40" />)}
        </div>
      ) : isError ? (
        <EmptyPanel icon={ShoppingBag} title="Marketplaces could not be loaded" className="mt-8" actions={<button type="button" className="fv-button-primary" onClick={() => void refetch()}>Try again</button>}>
          Check your connection and try again.
        </EmptyPanel>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((marketplace, index) => (
            <MarketplaceCard
              key={marketplace.id}
              marketplace={marketplace}
              index={index}
              onOpen={() => navigate(`/app/ecommerce/${marketplace.id}`)}
              onFiles={files => {
                // The workspace picks these up and imports them as it opens.
                setPendingFiles(marketplace.id, files);
                navigate(`/app/ecommerce/${marketplace.id}`);
              }}
            />
          ))}
        </div>
      )}

      <section className="mt-8 flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-[var(--fv-accent)]"><Zap className="h-4 w-4" aria-hidden="true" /></span>
          <div>
            <h2 className="text-sm font-semibold">Need a one-off GST file?</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Turn an Amazon, Flipkart, Meesho or other marketplace report into GST-ready data without saving a workspace.</p>
          </div>
        </div>
        <button type="button" className="fv-button-secondary shrink-0" onClick={() => navigate("/app/jobs/ecommerce-gst")}>
          Quick GST file <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        TallyThis reads the reports you download from each seller panel. It is not connected to your marketplace accounts and never signs in to them.
        Logos identify where a report comes from; no partnership is implied.
      </p>
    </div>
  );
}
