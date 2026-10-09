import "./lib/env";
import app from "./app";
import { logger } from "./lib/logger";
import { validateServerEnv } from "./server/envValidation";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

validateServerEnv();

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // No keep-alive pinger needed — Neon HTTP driver has no TCP cold-start.
});
