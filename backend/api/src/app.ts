import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuthContext } from "./middleware/authz";
import { periodLockMiddleware } from "./middleware/periodLock";
import { UnreadableFileError } from "./services/fileDetect";

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
// Job exports send reviewed rows back as JSON; the default 100 KB limit rejects
// ordinary multi-page statements before XML or Excel generation can start.
app.use("/api/jobs", express.json({ limit: "10mb" }));
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

  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large") {
    res.status(413).json({ ok: false, message: "This request is too large. Split the file into smaller statements and try again." });
    return;
  }

  if (err instanceof UnreadableFileError) {
    res.status(422).json({ ok: false, message: err.message });
    return;
  }

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
