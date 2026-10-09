import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuthContext } from "./middleware/authz";
import { periodLockMiddleware } from "./middleware/periodLock";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:21950";

const app: Express = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,   // allow embedded resources (charts, PDFs)
  contentSecurityPolicy: false,       // handled separately if needed
}));

// ── CORS — restrict to configured origin ─────────────────────────────────────
app.use(cors({
  origin: CORS_ORIGIN.split(",").map(s => s.trim()),
  credentials: true,
  methods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Period-Month", "X-Company-Id"],
}));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth + period-lock (after body parsing so body.periodMonth is available) ─
app.use(attachAuthContext);
app.use(periodLockMiddleware());

app.use("/api", router);

app.use("/api", (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown server error";
  req.log?.error({ err }, "API request failed");

  if (res.headersSent) return;

  const databaseUnavailable =
    message.toLowerCase().includes("timeout") ||
    message.toLowerCase().includes("connection") ||
    message.toLowerCase().includes("failed query");

  res.status(databaseUnavailable ? 503 : 500).json({
    error: databaseUnavailable
      ? "Database request timed out. Please check the backend database connection and try again."
      : "Server request failed. Please try again.",
  });
});

export default app;
