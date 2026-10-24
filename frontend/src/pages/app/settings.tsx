import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Building2, Bell, Shield, Users, Save, Database, FileText, History, Trash2, Cpu } from "lucide-react";
import PageHeader from "@/components/app/PageHeader";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken, getUser, login } from "@/lib/auth";
import { BRAND } from "@/lib/brand";
import { readJson } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface PlatformUser {
  id: number;
  name: string;
  email: string;
  role: string;
  status: string;
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
}

interface SecurityPosture {
  roleBasedAccessDesign: boolean;
  activeUsers: number;
  auditLogsEnabled: boolean;
  fileStorageMode: string;
  aiMode: string;
  aiProviderStatus?: {
    claude?: "configured" | "missing";
    gemini: "configured" | "missing";
    nvidia: "configured" | "missing";
    openrouter: "disabled" | "configured" | "missing";
    currentPrimaryModel: string;
    ruleBasedFallbackActive: boolean;
  };
  directIntegrationsLive: boolean;
  notes: string[];
}

interface CompanyRecord {
  name: string;
  gstin?: string | null;
  pan?: string | null;
  caEmail?: string | null;
  financialYearStart: string;
  dataRetentionDays: number;
}

export default function SettingsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const user = getUser();
  const { data: team = [] } = useQuery<PlatformUser[]>({
    queryKey: ["platformUsers"],
    queryFn: () => fetch(`${BASE}/api/users`).then(readJson),
  });
  const { data: auditLogs = [] } = useQuery<AuditLog[]>({
    queryKey: ["auditLogs"],
    queryFn: () => fetch(`${BASE}/api/audit-logs?limit=5`).then(readJson),
  });
  const { data: documents = [] } = useQuery<DocumentRecord[]>({
    queryKey: ["documents"],
    queryFn: () => fetch(`${BASE}/api/documents`).then(readJson),
  });
  const { data: security } = useQuery<SecurityPosture>({
    queryKey: ["securityPosture"],
    queryFn: () => fetch(`${BASE}/api/security/posture`).then(readJson),
  });
  const { data: companyRecord } = useQuery<CompanyRecord | null>({
    queryKey: ["company"],
    queryFn: () => fetch(`${BASE}/api/company`).then(readJson),
  });

  // Only fields the company record really stores. Nothing here is a made-up example value.
  const [company, setCompany] = useState({
    name: user?.company ?? "",
    gstin: "",
    pan: "",
    financialYearStart: "April",
    caEmail: "",
  });

  // What the person has typed before the saved details arrive is theirs: loading never writes over it.
  const edited = useRef(new Set<keyof typeof company>());
  const change = (key: keyof typeof company, value: string) => {
    edited.current.add(key);
    setCompany(current => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    if (!companyRecord) return;
    setCompany(current => ({
      name: edited.current.has("name") ? current.name : companyRecord.name ?? current.name,
      gstin: edited.current.has("gstin") ? current.gstin : companyRecord.gstin ?? "",
      pan: edited.current.has("pan") ? current.pan : companyRecord.pan ?? "",
      financialYearStart: edited.current.has("financialYearStart") ? current.financialYearStart : companyRecord.financialYearStart ?? current.financialYearStart,
      caEmail: edited.current.has("caEmail") ? current.caEmail : companyRecord.caEmail ?? "",
    }));
  }, [companyRecord]);

  const stored = companyRecord
    ? {
        name: companyRecord.name ?? "",
        gstin: companyRecord.gstin ?? "",
        pan: companyRecord.pan ?? "",
        financialYearStart: companyRecord.financialYearStart ?? "April",
        caEmail: companyRecord.caEmail ?? "",
      }
    : null;
  const dirty = stored != null && (Object.keys(stored) as Array<keyof typeof stored>).some(key => (company[key] ?? "").trim() !== stored[key]);

  // Save changes writes to the company record. It says "Saved" only after the server confirms it.
  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${BASE}/api/company`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: company.name, gstin: company.gstin, pan: company.pan, financialYearStart: company.financialYearStart, caEmail: company.caEmail }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) throw new Error(body.error || "Your changes could not be saved.");
      return body.company as CompanyRecord;
    },
    onSuccess: record => {
      edited.current.clear();
      qc.setQueryData(["company"], record);
      qc.invalidateQueries({ queryKey: ["auditLogs"] });
      if (user) login({ user: { ...user, company: record.name }, token: getAuthToken() ?? undefined });
      toast({ title: "Saved", description: "Your company details were updated." });
    },
    onError: (error: Error) => toast({ title: "Not saved", description: error.message, variant: "destructive" }),
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/documents/${id}`, { method: "DELETE" }).then(async response => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      qc.invalidateQueries({ queryKey: ["auditLogs"] });
      qc.invalidateQueries({ queryKey: ["securityPosture"] });
      toast({ title: "Document deleted", description: "Storage object was deleted when configured, and the document was audit logged." });
    },
    onError: () => {
      toast({ title: "Delete failed", description: "Could not delete the document.", variant: "destructive" });
    },
  });

  const sections = [
    {
      id: "company",
      icon: Building2,
      label: "Company Details",
      content: (
        <div className="grid md:grid-cols-2 gap-4">
          {[
            { label: "Company Name", key: "name" as const },
            { label: "GSTIN", key: "gstin" as const },
            { label: "PAN", key: "pan" as const },
          ].map(field => (
            <div key={field.key}>
              <label htmlFor={`company-${field.key}`} className="text-xs font-medium text-muted-foreground block mb-1.5">{field.label}</label>
              <input
                id={`company-${field.key}`}
                value={company[field.key]}
                onChange={e => change(field.key, e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          ))}
          <div>
            <label htmlFor="company-financialYearStart" className="text-xs font-medium text-muted-foreground block mb-1.5">Financial year starts in</label>
            <select
              id="company-financialYearStart"
              value={company.financialYearStart}
              onChange={e => change("financialYearStart", e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {["January", "April", "July", "October"].map(month => <option key={month} value={month}>{month}</option>)}
            </select>
          </div>
          <p className="md:col-span-2 text-xs text-muted-foreground">GSTIN and PAN are optional. They are asked for only when a job needs them.</p>
        </div>
      ),
    },
    {
      id: "ca",
      icon: Users,
      label: "CA Details",
      content: (
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="company-caEmail" className="text-xs font-medium text-muted-foreground block mb-1.5">CA Email</label>
            <input
              id="company-caEmail"
              type="email"
              value={company.caEmail}
              onChange={e => change("caEmail", e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      ),
    },
    {
      id: "team",
      icon: Users,
      label: "Team Members & Role Permissions",
      content: (
        <div className="space-y-3">
          {team.map(member => (
            <div key={member.id} className="flex items-center justify-between py-3 border-b border-border last:border-0">
              <div>
                <div className="text-sm font-medium">{member.name}</div>
                <div className="text-xs text-muted-foreground">{member.email}</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold capitalize">{member.role}</div>
                <div className="text-[11px] text-success capitalize">{member.status}</div>
              </div>
            </div>
          ))}
          {team.length === 0 && <p className="text-xs text-muted-foreground">No team members found for this workspace.</p>}
        </div>
      ),
    },
    {
      id: "notifications",
      icon: Bell,
      label: "Notification Preferences",
      content: (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Email alerts are not switched on yet, so there is nothing to turn on here. They will appear here when they are available.</p>
          {[
            { label: "Risk flag alerts", desc: "Get notified when new GST/TDS risks are detected" },
            { label: "Reconciliation complete", desc: "Notify when auto-reconciliation finishes" },
            { label: "CA review required", desc: "Notify CA when items need their attention" },
            { label: "Weekly summary report", desc: "Receive a weekly digest of verification progress" },
          ].map(n => (
            <div key={n.label} className="flex items-center justify-between py-3 border-b border-border last:border-0">
              <div>
                <div className="text-sm font-medium">{n.label}</div>
                <div className="text-xs text-muted-foreground">{n.desc}</div>
              </div>
              <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">Coming soon</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: "security",
      icon: Shield,
      label: "Security & Access",
      content: (
        <div className="space-y-4">
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="text-sm font-medium mb-0.5">Current Session</div>
            <div className="text-xs text-muted-foreground">
              Signed in as <strong>{user?.name}</strong> ({user?.role}) · {user?.email}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Two-Factor Authentication</div>
            <div className="text-xs text-muted-foreground mb-2">Add extra security with TOTP or SMS verification</div>
            <button
              type="button"
              disabled
              className="text-xs px-3 py-1.5 border border-border rounded-lg text-muted-foreground opacity-60 cursor-not-allowed"
            >
              Two-factor sign-in: coming soon
            </button>
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Data Export & GDPR</div>
            <div className="text-xs text-muted-foreground mb-2">There is no self-service export yet. Email us and we will send your data or delete your account.</div>
            <a
              href={`mailto:${BRAND.contactEmail}?subject=${encodeURIComponent("Data export or account deletion")}`}
              className="inline-block text-xs px-3 py-1.5 border border-border rounded-lg text-muted-foreground hover:text-foreground transition-colors"
            >
              Email {BRAND.contactEmail}
            </a>
          </div>
          <div className="grid md:grid-cols-2 gap-3 pt-2">
            {[
              { label: "RBAC design", value: security?.roleBasedAccessDesign ? "Enabled" : "Designed" },
              { label: "Audit logs", value: security?.auditLogsEnabled ? "Enabled" : "Designed" },
              { label: "File storage", value: security?.fileStorageMode === "metadata_only" ? "Metadata only" : "Configured" },
              { label: "AI mode", value: security?.aiMode ?? "rule-based" },
            ].map(item => (
              <div key={item.label} className="p-3 rounded-lg border border-border bg-background">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className="text-sm font-semibold">{item.value}</div>
              </div>
            ))}
          </div>
          {security?.notes?.map(note => (
            <p key={note} className="text-xs text-muted-foreground">{note}</p>
          ))}
        </div>
      ),
    },
    {
      id: "ai",
      icon: Cpu,
      label: "AI Status",
      content: (
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            {[
              { label: "Claude", value: security?.aiProviderStatus?.claude ?? "missing" },
              { label: "Gemini", value: security?.aiProviderStatus?.gemini ?? "missing" },
              { label: "Primary model", value: security?.aiProviderStatus?.currentPrimaryModel ?? "rule-based" },
              { label: "Fallback", value: security?.aiProviderStatus?.ruleBasedFallbackActive ? "Rule-based mode active" : "Primary only" },
              { label: "Output status", value: "AI suggested / pending review" },
            ].map(item => (
              <div key={item.label} className="p-3 rounded-lg border border-border bg-background">
                <div className="text-xs text-muted-foreground">{item.label}</div>
                <div className="text-sm font-semibold capitalize">{item.value}</div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            AI-assisted outputs are suggestions only. Source: AI suggestion. Source: deterministic rule. Potential risk — needs CA review.
          </div>
        </div>
      ),
    },
    {
      id: "data",
      icon: Database,
      label: "Data Store & Documents",
      content: (
        <div className="space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <div className="p-3 rounded-lg border border-border bg-background">
              <div className="text-xs text-muted-foreground">Documents</div>
              <div className="text-xl font-bold">{documents.length}</div>
            </div>
            <div className="p-3 rounded-lg border border-border bg-background">
              <div className="text-xs text-muted-foreground">Storage mode</div>
              <div className="text-sm font-semibold">{security?.fileStorageMode === "metadata_only" ? "Metadata only" : "Private R2"}</div>
            </div>
            <div className="p-3 rounded-lg border border-border bg-background">
              <div className="text-xs text-muted-foreground">Retention</div>
              <div className="text-sm font-semibold">365 days</div>
            </div>
          </div>
          <div className="space-y-2">
            {(documents.length ? documents.slice(0, 5) : []).map(document => (
              <div key={document.id} className="flex items-center justify-between text-sm py-2 border-b border-border last:border-0">
                <span className="flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-primary" />{document.fileName}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{document.sourceType} / {document.status}</span>
                  {document.status !== "deleted" && (
                    <button
                      type="button"
                      onClick={() => deleteDocumentMutation.mutate(document.id)}
                      disabled={deleteDocumentMutation.isPending}
                      className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-50 hover:text-red-700"
                      aria-label={`Delete ${document.fileName}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
            ))}
            {documents.length === 0 && <p className="text-xs text-muted-foreground">Upload a file to create document metadata records.</p>}
          </div>
        </div>
      ),
    },
    {
      id: "audit",
      icon: History,
      label: "Audit Logs",
      content: (
        <div className="space-y-2">
          {(auditLogs.length ? auditLogs : []).map(log => (
            <div key={log.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
              <div>
                <div className="text-sm font-medium">{log.action}</div>
                <div className="text-xs text-muted-foreground">{log.actorEmail ?? "system"} / {log.entityType}</div>
              </div>
              <div className="text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString("en-IN")}</div>
            </div>
          ))}
          {auditLogs.length === 0 && <p className="text-xs text-muted-foreground">Audit logs will appear after sign-ins, uploads, exports, and review actions.</p>}
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        title="Settings"
        subtitle="Manage your company profile and preferences"
        actions={
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            {saveMutation.isPending ? "Saving…" : "Save changes"}
          </button>
        }
      />

      <div className="space-y-4">
        {sections.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i }}
              className="bg-card border border-border rounded-xl overflow-hidden"
            >
              <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
                <Icon className="w-4 h-4 text-primary" />
                <div className="text-sm font-semibold">{s.label}</div>
              </div>
              <div className="p-5">{s.content}</div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
