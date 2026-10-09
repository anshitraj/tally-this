import { logger } from "../lib/logger";

function has(name: string): boolean {
  return Boolean(process.env[name]);
}

function any(names: string[]): boolean {
  return names.some((name) => has(name));
}

export function validateServerEnv() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = process.env.NODE_ENV === "production";

  if (!has("DATABASE_URL")) errors.push("DATABASE_URL is required");
  if (production && !any(["JWT_SECRET", "SESSION_SECRET"])) errors.push("JWT_SECRET or SESSION_SECRET is required in production");

  const r2Any = any([
    "CLOUDFLARE_R2_ACCOUNT_ID",
    "CLOUDFLARE_R2_ENDPOINT",
    "CLOUDFLARE_R2_BUCKET",
    "CLOUDFLARE_R2_ACCESS_KEY_ID",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  ]);
  const r2Complete = any(["CLOUDFLARE_R2_ENDPOINT", "STORAGE_ENDPOINT"]) || has("CLOUDFLARE_R2_ACCOUNT_ID")
    ? any(["CLOUDFLARE_R2_BUCKET", "STORAGE_BUCKET"])
      && any(["CLOUDFLARE_R2_ACCESS_KEY_ID", "STORAGE_ACCESS_KEY_ID"])
      && any(["CLOUDFLARE_R2_SECRET_ACCESS_KEY", "STORAGE_SECRET_ACCESS_KEY"])
    : false;
  if (r2Any && !r2Complete) warnings.push("Cloudflare R2 is partially configured; uploads will fail over to metadata-only or error when R2 is requested");

  if (any(["OPENROUTER_API_KEY", "Openrouter_API_Key"]) && process.env.OPENROUTER_ENABLED !== "true") {
    warnings.push("OpenRouter key is present but OpenRouter is disabled by default");
  }

  if (has("GOOGLE_CLIENT_ID") !== has("GOOGLE_CLIENT_SECRET")) {
    warnings.push("Google OAuth is partially configured");
  }
  if (has("GITHUB_CLIENT_ID") !== has("GITHUB_CLIENT_SECRET")) {
    warnings.push("GitHub OAuth is partially configured");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid server environment: ${errors.join("; ")}`);
  }
  for (const warning of warnings) {
    logger.warn({ warning }, "Server environment warning");
  }
}
