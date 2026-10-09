import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getR2Config } from "../server/storage/r2Client";
import { storePrivateFile } from "../server/storage/fileVault";

export interface StoredObject {
  provider: string;
  bucket: string | null;
  region: string | null;
  key: string | null;
  url: string | null;
  checksumSha256: string;
  sizeBytes: number;
}

export interface UploadFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size: number;
}

function storageProvider(): string {
  const r2 = getR2Config();
  if (r2.configured) return "r2";
  return (process.env.STORAGE_PROVIDER ?? "local").toLowerCase();
}

function objectKey(input: { companyId: number; sourceType: string; fileName: string }) {
  const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `companies/${input.companyId}/uploads/${input.sourceType}/${stamp}-${safeName || "upload"}`;
}

function configuredBucket(): string | null {
  return process.env.CLOUDFLARE_R2_BUCKET ?? process.env.STORAGE_BUCKET ?? process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? process.env.GCS_BUCKET ?? null;
}

function configuredRegion(): string | null {
  return process.env.STORAGE_REGION ?? process.env.AWS_REGION ?? "auto";
}

function storageEndpoint(): string | undefined {
  return process.env.CLOUDFLARE_R2_ENDPOINT ?? process.env.STORAGE_ENDPOINT ?? process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT ?? process.env.GCS_ENDPOINT;
}

function publicUrl(bucket: string, key: string): string | null {
  const base = process.env.CLOUDFLARE_R2_PUBLIC_URL ?? process.env.STORAGE_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, "")}/${key}`;
  return null;
}

function makeS3Client() {
  const endpoint = storageEndpoint();
  const region = configuredRegion() ?? "auto";
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ?? process.env.STORAGE_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ?? process.env.STORAGE_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true" || Boolean(endpoint),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  });
}

export function retentionUntil(days: number | null | undefined): Date | null {
  if (!days || days <= 0) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ─── Local disk storage ──────────────────────────────────────────────────────
// Used when no cloud credentials are configured (STORAGE_PROVIDER=local or unset).
// Files are written to ./uploads/ relative to cwd (configurable via LOCAL_UPLOADS_DIR).
// Files are served back via GET /api/uploads/files/:key on the API server.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

function localUploadsRoot(): string {
  return process.env.LOCAL_UPLOADS_DIR ?? join(process.cwd(), "uploads");
}

function localFilePath(key: string): string {
  // Prevent path traversal: strip backslashes, collapse ../, strip leading slashes.
  const safe = key.replace(/\\/g, "/").replace(/\.\.\//g, "").replace(/^\/+/, "");
  return join(localUploadsRoot(), safe);
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function storeLocalFile(input: {
  companyId: number;
  sourceType: string;
  file: UploadFileLike;
}): StoredObject {
  const checksumSha256 = createHash("sha256").update(input.file.buffer).digest("hex");
  const key = objectKey({ companyId: input.companyId, sourceType: input.sourceType, fileName: input.file.originalname });
  const dest = localFilePath(key);
  ensureDir(dest);
  writeFileSync(dest, input.file.buffer);
  return {
    provider: "local",
    bucket: null,
    region: null,
    key,
    // Relative URL served by the API — usable from the frontend as-is.
    url: `/api/uploads/files/${encodeURIComponent(key)}`,
    checksumSha256,
    sizeBytes: input.file.size,
  };
}

function readLocalFile(key: string): { buffer: Buffer; contentType: string } | null {
  try {
    const filePath = localFilePath(key);
    if (!existsSync(filePath)) return null;
    const buffer = readFileSync(filePath);
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const contentType =
      ext === "pdf" ? "application/pdf" :
      ext === "csv" ? "text/csv" :
      (ext === "xlsx" || ext === "xls") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" :
      ext === "png" ? "image/png" :
      (ext === "jpg" || ext === "jpeg") ? "image/jpeg" :
      "application/octet-stream";
    return { buffer, contentType };
  } catch {
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export async function storeUploadedFile(input: {
  companyId: number;
  sourceType: string;
  file: UploadFileLike;
}): Promise<StoredObject> {
  const provider = storageProvider();

  // Local disk — default when no cloud creds are set.
  if (provider === "local") {
    return storeLocalFile(input);
  }

  if (provider === "r2" && getR2Config().configured) {
    const stored = await storePrivateFile({
      companyId: input.companyId,
      sourceType: input.sourceType,
      file: input.file,
    });
    return {
      provider: stored.provider,
      bucket: stored.bucket,
      region: stored.region,
      key: stored.key,
      url: null,
      checksumSha256: stored.checksumSha256,
      sizeBytes: stored.sizeBytes,
    };
  }

  if (!["s3", "r2", "gcs"].includes(provider)) {
    throw new Error(`Unsupported STORAGE_PROVIDER "${provider}". Use local, s3, r2, or gcs.`);
  }

  const bucket = configuredBucket();
  if (!bucket) throw new Error("STORAGE_BUCKET env var is required for s3/gcs provider.");

  const checksumSha256 = createHash("sha256").update(input.file.buffer).digest("hex");
  const region = configuredRegion();
  const key = objectKey({ companyId: input.companyId, sourceType: input.sourceType, fileName: input.file.originalname });
  const client = makeS3Client();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: input.file.buffer,
    ContentType: input.file.mimetype || "application/octet-stream",
    Metadata: {
      companyId: String(input.companyId),
      sourceType: input.sourceType,
      checksumSha256,
    },
  }));

  return {
    provider,
    bucket,
    region,
    key,
    url: publicUrl(bucket, key),
    checksumSha256,
    sizeBytes: input.file.size,
  };
}

export async function deleteStoredObject(input: {
  provider: string;
  bucket?: string | null;
  key?: string | null;
}) {
  if (!input.key) return { deletedRemote: false };
  if (input.provider === "local") {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(localFilePath(input.key));
      return { deletedRemote: true };
    } catch {
      return { deletedRemote: false };
    }
  }
  if (!input.bucket || !["s3", "r2", "gcs"].includes(input.provider)) return { deletedRemote: false };
  const client = makeS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  return { deletedRemote: true };
}

export async function downloadStoredFile(input: {
  provider: string;
  bucket?: string | null;
  key?: string | null;
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!input.key) return null;
  if (input.provider === "local") return readLocalFile(input.key);
  if (!input.bucket || !["s3", "r2", "gcs"].includes(input.provider)) return null;
  const client = makeS3Client();
  const response = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
  if (!response.Body) return null;
  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: response.ContentType ?? "application/octet-stream",
  };
}
