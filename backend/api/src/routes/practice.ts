/**
 * CA Practice Console — a CA sees Tax Audit flagged counts across every client
 * they audit, on one screen. Reads ca_client_links for the authed CA user, runs
 * the audit engine per client, and aggregates.
 *
 * Falls back to synthetic demo clients (no real data) when the CA has no links
 * yet, so the console always renders.
 */
import { Router, type IRouter } from "express";
import { db, companiesTable, caClientLinksTable } from "@workspace/db";
import { sql, and, eq } from "drizzle-orm";
import { getCompanyId, requirePermission, auditAction } from "../middleware/authz";
import { buildChecks, DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS, type Ledger, type Voucher, type Bill, type AssetRow } from "../services/taxAuditEngine";
import { loadData } from "../services/taxAuditData";

const router: IRouter = Router();

interface ClientSummary {
  companyId: number | null;
  linkId: number | null;
  name: string;
  source: "tally" | "demo";
  flagged: number;
  total: number;
  highSeverity: number;
  byCategory: Record<string, number>;
  topClauses: { clause: string; title: string; count: number; severity: string }[];
  /** The client has no Tally data imported yet: no findings are shown for it (never the demo company's). */
  noData?: boolean;
}

function summarize(name: string, companyId: number | null, linkId: number | null, ledgers: Ledger[], vouchers: Voucher[], assets: AssetRow[], bills: Bill[], source: "tally" | "demo"): ClientSummary {
  const checks = buildChecks(ledgers, vouchers, assets, bills);
  const byCategory: Record<string, number> = {};
  for (const c of checks) if (c.rows.length > 0 && c.severity !== "info") byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  const flaggedChecks = checks.filter(c => c.rows.length > 0 && c.severity !== "info");
  return {
    companyId,
    linkId,
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
  const full = summarize("Nova Textiles Pvt Ltd", -1, null, DEMO_LEDGERS, DEMO_VOUCHERS, DEMO_ASSETS, DEMO_BILLS, "demo");
  // Client B: clean of cash-receipt 269ST issues
  const bVouchers = DEMO_VOUCHERS.filter(v => v.amount < 200000);
  const b = summarize("Apex Foods LLP", -2, null, DEMO_LEDGERS, bVouchers, DEMO_ASSETS, DEMO_BILLS, "demo");
  // Client C: no negative balances, no post-year-end JVs
  const cLedgers = DEMO_LEDGERS.map(l => l.group === "Sundry Debtors" && l.closingBalance < 0 ? { ...l, closingBalance: Math.abs(l.closingBalance) } : l);
  const cVouchers = DEMO_VOUCHERS.filter(v => v.date <= "2026-03-31");
  const c = summarize("Zenith Technologies", -3, null, cLedgers, cVouchers, DEMO_ASSETS, DEMO_BILLS, "demo");
  return [full, b, c];
}

router.get("/practice/clients", requirePermission("reports.read"), async (req, res): Promise<void> => {
  try {
    const caUserId = req.auth!.userId;
    getCompanyId(req); // ensures auth context

    // A database error is an error here, not an empty list: an empty one reads as "you have no clients".
    const found = await db.execute(sql`SELECT id, client_company_id, client_name FROM ca_client_links WHERE ca_user_id = ${caUserId} AND status = 'active' ORDER BY client_name`);
    const links = found.rows as { id: number; client_company_id: number; client_name: string | null }[];

    // The client list is read on every page (switcher, search, jobs). It must not run the audit
    // engine for each client, so a light read returns the names only.
    if (req.query.light === "1") {
      res.json({
        ok: true,
        source: links.length > 0 ? "links" : "demo",
        clients: links.map(link => ({
          companyId: link.client_company_id,
          linkId: link.id,
          name: link.client_name ?? `Client #${link.client_company_id}`,
          source: "tally" as const,
        })),
      });
      return;
    }

    let clients: ClientSummary[];
    let source: "links" | "demo";
    if (links.length > 0) {
      source = "links";
      clients = [];
      for (const link of links) {
        const name = link.client_name ?? `Client #${link.client_company_id}`;
        const data = await loadData(link.client_company_id);
        if (data.source === "demo") {
          // Nothing imported for this client: say so, rather than show the demo company's findings under their name.
          clients.push({ companyId: link.client_company_id, linkId: link.id, name, source: "demo", flagged: 0, total: 0, highSeverity: 0, byCategory: {}, topClauses: [], noData: true });
          continue;
        }
        clients.push(summarize(name, link.client_company_id, link.id, data.ledgers, data.vouchers, data.assets, data.bills, data.source));
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

/** Link a new client company to this CA. Creates a lightweight company row. */
router.post("/practice/clients", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  try {
    const caUserId = req.auth!.userId;
    const caCompanyId = getCompanyId(req);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) { res.status(400).json({ ok: false, error: "Client name is required" }); return; }
    const gstin = typeof req.body?.gstin === "string" ? req.body.gstin.trim() : null;
    const pan = typeof req.body?.pan === "string" ? req.body.pan.trim() : null;

    // The same client twice (a second click, a page reload, going through setup again) must not make a copy.
    const already = await db.execute(sql`
      SELECT id, client_company_id, client_name FROM ca_client_links
      WHERE ca_user_id = ${caUserId} AND status = 'active' AND lower(btrim(client_name)) = lower(${name})
      ORDER BY id LIMIT 1`);
    const existing = already.rows[0] as { id: number; client_company_id: number; client_name: string } | undefined;
    if (existing) {
      res.status(409).json({
        ok: false,
        error: "You already have a client with this name.",
        client: { companyId: existing.client_company_id, name: existing.client_name, linkId: existing.id },
      });
      return;
    }

    const [company] = await db.insert(companiesTable).values({
      name, industry: typeof req.body?.industry === "string" && req.body.industry ? req.body.industry : "Unspecified",
      gstin, pan,
    }).returning({ id: companiesTable.id });

    const [link] = await db.insert(caClientLinksTable).values({
      caUserId, caCompanyId, clientCompanyId: company.id, clientName: name, status: "active",
    }).returning();

    await auditAction(req, "practice.client_linked", "ca_client_link", link.id, { clientCompanyId: company.id, name });
    res.json({ ok: true, client: { companyId: company.id, name, linkId: link.id } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "add_client_failed" });
  }
});

/** Rename a client in this CA's list. Only the CA's own link is changed, never the company row. */
router.patch("/practice/clients/:linkId", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  try {
    const caUserId = req.auth!.userId;
    const linkId = Number(req.params.linkId);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!Number.isInteger(linkId)) { res.status(400).json({ ok: false, error: "invalid id" }); return; }
    if (!name) { res.status(400).json({ ok: false, error: "Client name is required" }); return; }
    if (name.length > 120) { res.status(400).json({ ok: false, error: "Client name is too long" }); return; }
    const updated = await db.update(caClientLinksTable)
      .set({ clientName: name })
      .where(and(eq(caClientLinksTable.id, linkId), eq(caClientLinksTable.caUserId, caUserId)))
      .returning({ id: caClientLinksTable.id });
    if (updated.length === 0) { res.status(404).json({ ok: false, error: "link not found" }); return; }
    await auditAction(req, "practice.client_renamed", "ca_client_link", linkId, { name });
    res.json({ ok: true, client: { linkId, name } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "rename_client_failed" });
  }
});

/** Unlink a client (only if it belongs to this CA). */
router.delete("/practice/clients/:linkId", requirePermission("uploads.create"), async (req, res): Promise<void> => {
  try {
    const caUserId = req.auth!.userId;
    const linkId = Number(req.params.linkId);
    if (!Number.isInteger(linkId)) { res.status(400).json({ ok: false, error: "invalid id" }); return; }
    const deleted = await db.delete(caClientLinksTable)
      .where(and(eq(caClientLinksTable.id, linkId), eq(caClientLinksTable.caUserId, caUserId)))
      .returning({ id: caClientLinksTable.id });
    if (deleted.length === 0) { res.status(404).json({ ok: false, error: "link not found" }); return; }
    await auditAction(req, "practice.client_unlinked", "ca_client_link", linkId, {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "remove_client_failed" });
  }
});

export default router;
