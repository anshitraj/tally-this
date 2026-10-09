import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Database,
  FileText,
  History,
  LockKeyhole,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import { useLocation } from "wouter";
import PageHeader from "@/components/app/PageHeader";
import StatusBadge from "@/components/app/StatusBadge";
import { PageTransition, StatCard } from "@/components/app/finverify-ui";
import { formatDate } from "@/lib/format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt?: string | null;
}

interface AuditLog {
  id: number;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  createdAt: string;
}

interface DocumentRecord {
  id: number;
  fileName: string;
  sourceType: string;
  storageProvider: string;
  status: string;
  extractedTextStatus: string;
  createdAt?: string;
}

interface SecurityPosture {
  roleBasedAccessDesign: boolean;
  activeUsers: number;
  auditLogsEnabled: boolean;
  auditLogEvents?: number;
  fileStorageMode: string;
  aiMode: string;
  directIntegrationsLive: boolean;
  dataExportDeleteControls?: boolean;
  notes: string[];
}

const DEMO_USERS: AdminUser[] = [
  { id: 1, name: "Rahul Mehta", email: "rahul@novastack.in", role: "founder", status: "active", lastLoginAt: "2026-05-24T14:18:00.000Z" },
  { id: 2, name: "Ananya Rao", email: "admin@novastack.in", role: "admin", status: "active", lastLoginAt: "2026-05-23T11:30:00.000Z" },
  { id: 3, name: "CA Priya Sharma", email: "ca@finverify.in", role: "ca", status: "active", lastLoginAt: "2026-05-22T09:05:00.000Z" },
];

const DEMO_AUDIT_LOGS: AuditLog[] = [
  { id: 1, actorEmail: "rahul@novastack.in", action: "upload.created", entityType: "bank_statement", createdAt: "2026-05-24T12:50:00.000Z" },
  { id: 2, actorEmail: "ca@finverify.in", action: "risk.reviewed", entityType: "gst_risk", createdAt: "2026-05-24T10:20:00.000Z" },
  { id: 3, actorEmail: "system", action: "reconciliation.run", entityType: "transaction", createdAt: "2026-05-23T16:40:00.000Z" },
];

const DEMO_DOCUMENTS: DocumentRecord[] = [
  { id: 1, fileName: "HDFC bank statement - May.csv", sourceType: "bank_statement", storageProvider: "metadata_only", status: "verified", extractedTextStatus: "parsed", createdAt: "2026-05-21T09:30:00.000Z" },
  { id: 2, fileName: "Zoho invoices export.xlsx", sourceType: "invoice_export", storageProvider: "metadata_only", status: "needs_ca_review", extractedTextStatus: "parsed", createdAt: "2026-05-20T14:10:00.000Z" },
  { id: 3, fileName: "GST 2B reconciliation.pdf", sourceType: "gst_file", storageProvider: "metadata_only", status: "potential_risk", extractedTextStatus: "metadata_only", createdAt: "2026-05-18T11:45:00.000Z" },
];

const DEMO_SECURITY: SecurityPosture = {
  roleBasedAccessDesign: true,
  activeUsers: 3,
  auditLogsEnabled: true,
  auditLogEvents: 3,
  fileStorageMode: "metadata_only",
  aiMode: "rule-based",
  directIntegrationsLive: false,
  dataExportDeleteControls: true,
  notes: [
    "Current workflows are upload-based unless a source is marked available in code.",
    "Local Tally connector is available when Tally is reachable from the API host; bank, GST, and gateway API connections are not live.",
    "Potential risk — needs CA review before financial close.",
  ],
};

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

function roleTone(role: string) {
  if (role === "founder") return "fv-status-verified";
  if (role === "admin") return "fv-status-review";
  return "fv-status-unverified";
}

export default function AdminPage() {
  const [, navigate] = useLocation();
  const { data: users = DEMO_USERS } = useQuery<AdminUser[]>({
    queryKey: ["adminUsers"],
    queryFn: () => fetchJson<AdminUser[]>("/api/users"),
    initialData: DEMO_USERS,
  });
  const { data: auditLogs = DEMO_AUDIT_LOGS } = useQuery<AuditLog[]>({
    queryKey: ["adminAuditLogs"],
    queryFn: () => fetchJson<AuditLog[]>("/api/audit-logs?limit=6"),
    initialData: DEMO_AUDIT_LOGS,
  });
  const { data: documents = DEMO_DOCUMENTS } = useQuery<DocumentRecord[]>({
    queryKey: ["adminDocuments"],
    queryFn: () => fetchJson<DocumentRecord[]>("/api/documents"),
    initialData: DEMO_DOCUMENTS,
  });
  const { data: security = DEMO_SECURITY } = useQuery<SecurityPosture>({
    queryKey: ["adminSecurityPosture"],
    queryFn: () => fetchJson<SecurityPosture>("/api/security/posture"),
    initialData: DEMO_SECURITY,
  });

  const openDocuments = documents.filter(document => document.status !== "deleted");
  const reviewDocuments = documents.filter(document => ["needs_ca_review", "potential_risk", "missing_invoice"].includes(document.status));
  const activeUsers = users.filter(user => user.status === "active");
  const caUsers = users.filter(user => user.role === "ca");

  const controls = [
    { label: "RBAC", value: security.roleBasedAccessDesign ? "Designed" : "Not configured", status: "verified" },
    { label: "Audit trail", value: security.auditLogsEnabled ? "Enabled" : "Not enabled", status: security.auditLogsEnabled ? "verified" : "unverified" },
    { label: "File storage", value: security.fileStorageMode === "metadata_only" ? "Metadata only" : "Configured", status: "needs_ca_review" },
    { label: "AI mode", value: security.aiMode === "ai-assisted" ? "AI-assisted" : "Rule-first", status: "verified" },
    { label: "Direct integrations", value: security.directIntegrationsLive ? "Live" : "Not live", status: security.directIntegrationsLive ? "verified" : "unverified" },
    { label: "Data controls", value: security.dataExportDeleteControls ? "Available" : "Planned", status: security.dataExportDeleteControls ? "verified" : "needs_ca_review" },
  ];

  return (
    <PageTransition className="mx-auto max-w-7xl">
      <PageHeader
        title="Admin Dashboard"
        subtitle="Workspace operations, access control, document governance, and audit readiness for the upload-based TallyThis prototype."
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => navigate("/app/uploads")} className="fv-button-primary">
              <Upload className="h-4 w-4" />
              Upload files
            </button>
            <button type="button" onClick={() => navigate("/app/settings")} className="fv-button-secondary">
              <LockKeyhole className="h-4 w-4" />
              Manage settings
            </button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active users" value={activeUsers.length} detail={`${caUsers.length} CA reviewer${caUsers.length === 1 ? "" : "s"}`} icon={Users} tone="info" />
        <StatCard label="Open documents" value={openDocuments.length} detail="Uploads and parsed metadata" icon={FileText} tone="success" />
        <StatCard label="Needs attention" value={reviewDocuments.length} detail="Review or risk status" icon={AlertTriangle} tone={reviewDocuments.length ? "warning" : "success"} />
        <StatCard label="Audit events" value={auditLogs.length} detail="Recent governance log entries" icon={History} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="fv-card-flat overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <div className="text-sm font-semibold">Team and roles</div>
              <div className="text-xs text-muted-foreground">Admin visibility across workspace access</div>
            </div>
            <button type="button" onClick={() => navigate("/app/settings")} className="text-xs font-semibold text-primary hover:underline">
              Edit users
            </button>
          </div>
          <div className="divide-y divide-border">
            {users.map(user => (
              <div key={user.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{user.name}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{user.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${roleTone(user.role)}`}>{user.role}</span>
                  <StatusBadge status={user.status === "active" ? "verified" : "unverified"} />
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }} className="fv-card-flat p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Security posture</div>
              <div className="text-xs text-muted-foreground">Designed controls and current prototype status</div>
            </div>
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {controls.map(control => (
              <div key={control.label} className="rounded-xl border border-border bg-background p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="text-xs font-medium text-muted-foreground">{control.label}</div>
                  <StatusBadge status={control.status} />
                </div>
                <div className="text-sm font-semibold">{control.value}</div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="fv-card-flat overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <div className="text-sm font-semibold">Document governance</div>
              <div className="text-xs text-muted-foreground">Upload inventory and review status</div>
            </div>
            <Database className="h-5 w-5 text-primary" />
          </div>
          <div className="divide-y divide-border">
            {documents.slice(0, 5).map(document => (
              <button key={document.id} type="button" onClick={() => navigate("/app/uploads")} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-muted/40">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{document.fileName}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{document.sourceType.replace(/_/g, " ")} / {document.storageProvider}</span>
                </span>
                <StatusBadge status={document.status} />
              </button>
            ))}
          </div>
        </div>

        <div className="fv-card-flat overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <div className="text-sm font-semibold">Recent audit trail</div>
              <div className="text-xs text-muted-foreground">Latest workspace actions</div>
            </div>
            <button type="button" onClick={() => navigate("/app/settings")} className="text-xs font-semibold text-primary hover:underline">
              View settings
            </button>
          </div>
          <div className="divide-y divide-border">
            {auditLogs.map(log => (
              <div key={log.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-primary" />
                    <div className="truncate text-sm font-semibold">{log.action}</div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{log.actorEmail ?? "system"} / {log.entityType}</div>
                </div>
                <div className="text-xs text-muted-foreground">{formatDate(log.createdAt)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="mt-5 rounded-2xl border border-primary/20 bg-primary/5 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <ShieldCheck className="h-4 w-4" />
              Admin guardrails
            </div>
            <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground md:grid-cols-3">
              {security.notes.map(note => <p key={note}>{note}</p>)}
            </div>
          </div>
          <button type="button" onClick={() => navigate("/app/reports")} className="fv-button-secondary shrink-0">
            Open reports
            <ArrowUpRight className="h-4 w-4" />
          </button>
        </div>
      </motion.div>
    </PageTransition>
  );
}
