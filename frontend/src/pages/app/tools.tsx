import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Search } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { PageTransition } from "@/components/app/finverify-ui";
import { ADVANCED_GROUPS, type NavEntry } from "@/lib/navigation";

/** Every word typed must appear somewhere in the name, the one-line hint or the search words. */
function matches(entry: NavEntry, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${entry.label} ${entry.hint ?? ""} ${entry.keywords ?? ""}`.toLowerCase();
  return words.every(word => text.includes(word));
}

/**
 * Everything the side menu leaves out: the other jobs and every older page, grouped. Nothing here is new; it
 * used to be a long list in the side menu.
 */
export default function ToolsPage() {
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () =>
      ADVANCED_GROUPS.map(group => ({ ...group, items: group.items.filter(item => matches(item, query)) })).filter(
        group => group.items.length > 0,
      ),
    [query],
  );

  return (
    <PageTransition className="mx-auto max-w-5xl">
      <PageHeader
        title="Advanced"
        subtitle="Every other job and page. The everyday jobs are in the menu on the left; you only need this page for the rest."
      />

      <label className="relative mb-8 block max-w-md">
        <span className="sr-only">Find a job or page</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Find a job or page"
          className="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          Nothing matches “{query.trim()}”. Try one word, such as “gst”, “tds” or “payroll”.
        </p>
      ) : (
        groups.map(group => (
          <section key={group.title} className="mb-8" aria-labelledby={`tools-${group.title}`}>
            <h2 id={`tools-${group.title}`} className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map(item => {
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex h-full items-start gap-3 rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40 hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                        <Icon className="h-4 w-4" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-foreground">{item.label}</span>
                        {item.hint && <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.hint}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </PageTransition>
  );
}
