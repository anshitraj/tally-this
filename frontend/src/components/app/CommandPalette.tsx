import { useEffect, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ArrowRight, Building2, CornerDownLeft, LogOut, Plus, Search, UploadCloud } from "lucide-react";
import {
  ADVANCED_GROUPS,
  GST_RECON_JOB,
  JOB_NAV,
  SECONDARY_NAV,
  TOOLS_ENTRY,
  WORKSPACE_NAV,
  type NavEntry,
} from "@/lib/navigation";
import { useClients } from "@/components/jobs/jobUi";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
  onSignOut: () => void;
}

function Row({
  value,
  keywords,
  icon,
  title,
  hint,
  onSelect,
}: {
  value: string;
  keywords?: string[];
  icon: ReactNode;
  title: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className="fv-palette-item">
      <span className="fv-palette-icon" aria-hidden="true">{icon}</span>
      <span className="fv-palette-copy">
        <span className="fv-palette-title">{title}</span>
        {hint && <span className="fv-palette-hint">{hint}</span>}
      </span>
      <ArrowRight className="fv-palette-go" aria-hidden="true" />
    </Command.Item>
  );
}

function entryRow(entry: NavEntry, onNavigate: (href: string) => void) {
  const Icon = entry.icon;
  return (
    <Row
      key={entry.href}
      value={`${entry.label} ${entry.href}`}
      keywords={entry.keywords?.split(" ")}
      icon={<Icon size={16} />}
      title={entry.label}
      hint={entry.hint}
      onSelect={() => onNavigate(entry.href)}
    />
  );
}

/** Press Ctrl+K (or ⌘K) anywhere to jump to a job, a page or a client. */
export default function CommandPalette({ open, onOpenChange, onNavigate, onSignOut }: Props) {
  const { clients, choose } = useClients();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fv-palette-overlay" />
        <DialogPrimitive.Content className="fv-palette" aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">Search TallyThis</DialogPrimitive.Title>
          <Command loop label="Search TallyThis">
            <div className="fv-palette-input">
              <Search size={16} aria-hidden="true" />
              <Command.Input autoFocus placeholder="Search jobs, pages or clients" />
              <kbd>Esc</kbd>
            </div>
            <Command.List>
              <Command.Empty>
                Nothing matches that. Try “bank”, “GST”, “TDS” or a client name.
              </Command.Empty>

              <Command.Group heading="Start a job">
                <Row
                  value="Upload a file drop files home"
                  keywords={["upload", "drop", "file", "start"]}
                  icon={<UploadCloud size={16} />}
                  title="Upload a file"
                  hint="We’ll identify it and open the right job"
                  onSelect={() => run(() => onNavigate("/app/overview"))}
                />
                {[...JOB_NAV, GST_RECON_JOB].map(entry => entryRow(entry, href => run(() => onNavigate(href))))}
              </Command.Group>

              {clients.length > 0 && (
                <Command.Group heading="Switch client">
                  {clients.map(client => (
                    <Row
                      key={`${client.linkId}-${client.name}`}
                      value={`client ${client.name}`}
                      keywords={["switch", "client", "company"]}
                      icon={<Building2 size={16} />}
                      title={client.name}
                      hint="Work on this client’s books"
                      onSelect={() =>
                        run(() => {
                          choose({ id: client.companyId, name: client.name, accounting: "Tally", linkId: client.linkId });
                          onNavigate("/app/overview");
                        })
                      }
                    />
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Go to">
                {[...WORKSPACE_NAV, ...SECONDARY_NAV, TOOLS_ENTRY].map(entry => entryRow(entry, href => run(() => onNavigate(href))))}
                <Row
                  value="Add a client new business"
                  keywords={["new", "client", "add", "business"]}
                  icon={<Plus size={16} />}
                  title="Add a client"
                  hint="Just a business name is enough"
                  onSelect={() => run(() => onNavigate("/app/clients?add=1"))}
                />
              </Command.Group>

              {ADVANCED_GROUPS.map(group => (
                <Command.Group key={group.title} heading={group.title}>
                  {group.items
                    .filter(entry => entry.href !== GST_RECON_JOB.href)
                    .map(entry => entryRow(entry, href => run(() => onNavigate(href))))}
                </Command.Group>
              ))}

              <Command.Group heading="Account">
                <Row
                  value="Sign out log out"
                  keywords={["logout", "sign", "out", "exit"]}
                  icon={<LogOut size={16} />}
                  title="Sign out"
                  onSelect={() => run(onSignOut)}
                />
              </Command.Group>
            </Command.List>
            <div className="fv-palette-foot">
              <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
              <span><CornerDownLeft size={12} aria-hidden="true" /> to open</span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
