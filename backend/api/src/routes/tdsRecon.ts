/**
 * 26AS vs Books TDS reconciliation routes.
 *   GET  /api/tax-audit/tds-recon          — demo reconciliation (renders before upload)
 *   POST /api/tax-audit/tds-recon          — upload 26AS + books CSVs, match, return result
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { requirePermission } from "../middleware/authz";
import { reconcile26AS, DEMO_26AS, DEMO_BOOKS, type TdsEntry } from "../services/tdsReconEngine";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Minimal CSV → TdsEntry parser. Maps columns by fuzzy header name. */
function parseTdsCsv(buf: Buffer): TdsEntry[] {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = (l: string) => l.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map(h => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex(h => names.some(n => h.includes(n)));
  const iDeductor = find("deductor", "name", "party");
  const iTan = find("tan");
  const iSection = find("section", "sec");
  const iAmount = find("tds", "amount", "tax");
  const out: TdsEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    const amount = parseFloat((c[iAmount] ?? "").replace(/[^0-9.\-]/g, "")) || 0;
    if (amount === 0 && !(c[iDeductor] || c[iTan])) continue;
    out.push({
      deductor: iDeductor >= 0 ? c[iDeductor] ?? "" : "",
      tan: iTan >= 0 ? c[iTan] ?? "" : "",
      section: iSection >= 0 ? c[iSection] ?? "" : "",
      amount,
    });
  }
  return out;
}

router.get("/tax-audit/tds-recon", requirePermission("reports.read"), async (_req, res): Promise<void> => {
  const result = reconcile26AS(DEMO_26AS, DEMO_BOOKS);
  res.json({ ok: true, source: "demo", ...result });
});

router.post(
  "/tax-audit/tds-recon",
  requirePermission("reports.read"),
  upload.fields([{ name: "as26", maxCount: 1 }, { name: "books", maxCount: 1 }]),
  async (req, res): Promise<void> => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const as26File = files?.as26?.[0];
    const booksFile = files?.books?.[0];
    if (!as26File || !booksFile) { res.status(400).json({ ok: false, error: "Upload both a 26AS CSV and a books CSV." }); return; }
    const as26 = parseTdsCsv(as26File.buffer);
    const books = parseTdsCsv(booksFile.buffer);
    if (as26.length === 0 && books.length === 0) { res.status(422).json({ ok: false, error: "No TDS rows found. Expected columns: deductor, TAN, section, amount." }); return; }
    const result = reconcile26AS(as26, books);
    res.json({ ok: true, source: "upload", counts: { as26: as26.length, books: books.length }, ...result });
  },
);

export default router;
