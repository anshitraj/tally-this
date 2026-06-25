/**
 * CA Practice Console — a CA sees Tax Audit flagged counts across every client
 * they audit, on one screen. Reads ca_client_links for the authed CA user, runs
 * the audit engine per client, and aggregates.
 *
 * Falls back to synthetic demo clients (no real data) when the CA has no links
 * yet, so the console always renders.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCompanyId, requirePermission } from "../middleware/authz";
import { buildChecks, DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, type Ledger, type Voucher } from "../services/taxAuditEngine";
import { loadData } from "../services/taxAuditData";

const router: IRouter = Router();

interface ClientSummary {
  companyId: number | null;
  name: string;
  source: "tally" | "demo";
  flagged: number;
  total: number;
  highSeverity: number;
  byCategory: Record<string, number>;
  topClauses: { clause: string; title: string; count: number; severity: string }[];
}

function summarize(name: string, companyId: number | null, ledgers: Ledger[], vouchers: Voucher[], source: "tally" | "demo"): ClientSummary {
  const checks = buildChecks(ledgers, vouchers, DEMO_ASSETS);
  const byCategory: Record<string, number> = {};
  for (const c of checks) if (c.rows.length > 0 && c.severity !== "info") byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  const flaggedChecks = checks.filter(c => c.rows.length > 0 && c.severity !== "info");
  return {
    companyId,
    name,
    source,
    flagged: flaggedChecks.length,
    total: checks.length,
    highSeverity: checks.filter(c => c.severity === "high" && c.rows.length > 0).length,
    byCategory,
    topClauses: checks
      .filter(c => c.rows.length > 0 && c.severity === "high")
      .slice(0, 4)
      .map(c => ({ clause: c.clause, title: c.title, count: c.rows.length, severity: c.severity })),
  };
}

// Demo clients — derived from the demo dataset with deterministic variations so
// the console looks like a real multi-client practice.
function demoClients(): ClientSummary[] {
  const full = summarize("Nova Textiles Pvt Ltd", -1, DEMO_LEDGERS, DEMO_VOUCHERS, "demo");
  // Client B: clean of cash-receipt 269ST issues
  const bVouchers = DEMO_VOUCHERS.filter(v => v.amount < 200000);
  const b = summarize("Apex Foods LLP", -2, DEMO_LEDGERS, bVouchers, "demo");
  // Client C: no negative balances, no post-year-end JVs
  const cLedgers = DEMO_LEDGERS.map(l => l.group === "Sundry Debtors" && l.closingBalance < 0 ? { ...l, closingBalance: Math.abs(l.closingBalance) } : l);
  const cVouchers = DEMO_VOUCHERS.filter(v => v.date <= "2026-03-31");
  const c = summarize("Zenith Technologies", -3, cLedgers, cVouchers, "demo");
  return [full, b, c];
}

router.get("/practice/clients", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const caUserId = req.auth!.userId;
    getCompanyId(req); // ensures auth context

    let links: { client_company_id: number; client_name: string | null }[] = [];
    try {
      const r = await db.execute(sql`SELECT client_company_id, client_name FROM ca_client_links WHERE ca_user_id = ${caUserId} AND status = 'active' ORDER BY client_name`);
      links = r.rows as { client_company_id: number; client_name: string | null }[];
    } catch { /* table missing — demo */ }

    let clients: ClientSummary[];
    let source: "links" | "demo";
    if (links.length > 0) {
      source = "links";
      clients = [];
      for (const link of links) {
        const data = await loadData(link.client_company_id);
        clients.push(summarize(link.client_name ?? `Client #${link.client_company_id}`, link.client_company_id, data.ledgers, data.vouchers, data.source));
      }
    } else {
      source = "demo";
      clients = demoClients();
    }

    const totals = {
      clients: clients.length,
      flagged: clients.reduce((s, c) => s + c.flagged, 0),
      highSeverity: clients.reduce((s, c) => s + c.highSeverity, 0),
      needsAttention: clients.filter(c => c.highSeverity > 0).length,
    };

    res.json({ ok: true, source, clients: clients.sort((a, b) => b.highSeverity - a.highSeverity || b.flagged - a.flagged), totals });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "practice_failed" });
  }
});

export default router;
