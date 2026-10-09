import { Router, type IRouter } from "express";
import { getAIStatus } from "../server/ai/providerRouter";
import { validateDatabaseConnection } from "../server/db";
import { validateR2Connection } from "../server/storage/r2Client";

const router: IRouter = Router();

async function healthPayload() {
  const [db, r2] = await Promise.all([
    validateDatabaseConnection(),
    validateR2Connection(),
  ]);
  const ai = getAIStatus();
  return {
    ok: db === "ok",
    db,
    r2,
    ai: {
      claude: ai.claude,
      gemini: ai.gemini,
      nvidia: ai.nvidia,
      openrouter: ai.openrouter,
    },
  };
}

router.get("/healthz", async (_req, res) => {
  const data = await healthPayload();
  res.status(data.ok ? 200 : 503).json(data);
});

router.get("/health", async (_req, res) => {
  const data = await healthPayload();
  res.status(data.ok ? 200 : 503).json(data);
});

export default router;
