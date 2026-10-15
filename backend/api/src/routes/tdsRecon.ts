/**
 * 26AS vs Books TDS reconciliation routes.
 *   GET  /api/tax-audit/tds-recon          — demo reconciliation (renders before upload)
 *   POST /api/tax-audit/tds-recon          — upload 26AS + books files, match, return result
 *
 * 26AS can be the TRACES text file, or Excel/CSV. Books can be any ledger report that has a
 * party name (a TAN is optional) and a TDS amount.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { requirePermission } from "../middleware/authz";
import { reconcile26AS, DEMO_26AS, DEMO_BOOKS } from "../services/tdsReconEngine";
import { readTdsFile } from "../services/tdsFiles";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    if (!as26File || !booksFile) {
      res.status(400).json({ ok: false, error: "Upload both files: Form 26AS and the TDS from your books." });
      return;
    }
    try {
      const as26 = readTdsFile(as26File);
      const books = readTdsFile(booksFile);
      if (as26.entries.length === 0) {
        res.status(422).json({
          ok: false,
          error: "No TDS lines were found in the 26AS file. Download the text (.txt) or Excel version of Form 26AS from TRACES and upload that.",
        });
        return;
      }
      if (books.entries.length === 0) {
        res.status(422).json({
          ok: false,
          error: "No TDS amounts were found in the books file. It needs a party name and a TDS amount column.",
        });
        return;
      }
      const result = reconcile26AS(as26.entries, books.entries);
      res.json({
        ok: true,
        source: "upload",
        counts: { as26: as26.entries.length, books: books.entries.length },
        notes: [...as26.notes.map(note => `26AS: ${note}`), ...books.notes.map(note => `Books: ${note}`)],
        ...result,
      });
    } catch (error) {
      res.status(422).json({ ok: false, error: error instanceof Error ? error.message : "These files could not be read." });
    }
  },
);

export default router;
