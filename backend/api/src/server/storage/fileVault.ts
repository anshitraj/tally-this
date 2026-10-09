import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db, fileAccessLogsTable, fileUploadsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { createR2Client, getR2Config } from "./r2Client";

export type VaultFile = {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size: number;
};

export type VaultStoredFile = {
  provider: "r2";
  bucket: string;
  key: string;
  region: string;
  checksumSha256: string;
  sizeBytes: number;
  encrypted: true;
};

const allowedMimeTypes = new Set([
  "text/csv",
  "application/csv",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function validateVaultFile(file: VaultFile) {
  if (file.size <= 0) throw new Error("Uploaded file is empty");
  if (file.size > 50 * 1024 * 1024) throw new Error("Uploaded file exceeds 50MB limit");
  if (file.mimetype && !allowedMimeTypes.has(file.mimetype)) {
    throw new Error(`Unsupported file type ${file.mimetype}`);
  }
}

function objectKey(input: { companyId: number; sourceType: string; originalName: string }) {
  const safeName = input.originalName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "upload";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `companies/${input.companyId}/uploads/${input.sourceType}/${stamp}-${randomUUID()}-${safeName}`;
}

export async function storePrivateFile(input: {
  companyId: number;
  userId?: number | null;
  sourceType: string;
  file: VaultFile;
}): Promise<VaultStoredFile> {
  validateVaultFile(input.file);
  const r2 = getR2Config();
  if (!r2.configured || !r2.bucket) throw new Error("r2_not_configured");

  const key = objectKey({ companyId: input.companyId, sourceType: input.sourceType, originalName: input.file.originalname });
  const checksumSha256 = createHash("sha256").update(input.file.buffer).digest("hex");
  await createR2Client().send(new PutObjectCommand({
    Bucket: r2.bucket,
    Key: key,
    Body: input.file.buffer,
    ContentType: input.file.mimetype || "application/octet-stream",
    ChecksumSHA256: Buffer.from(checksumSha256, "hex").toString("base64"),
    Metadata: {
      companyId: String(input.companyId),
      sourceType: input.sourceType,
      checksumSha256,
    },
  }));

  try {
    await db.insert(fileUploadsTable).values({
      companyId: input.companyId,
      userId: input.userId ?? null,
      sourceType: input.sourceType,
      originalFileName: input.file.originalname,
      mimeType: input.file.mimetype ?? null,
      sizeBytes: input.file.size,
      r2Key: key,
      encrypted: true,
      encryptionVersion: "r2-managed",
      status: "stored",
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "File upload metadata write failed");
  }

  return {
    provider: "r2",
    bucket: r2.bucket,
    key,
    region: r2.region,
    checksumSha256,
    sizeBytes: input.file.size,
    encrypted: true,
  };
}

export async function createSignedFileUrl(input: {
  companyId: number;
  userId?: number | null;
  key: string;
  expiresInSeconds?: number;
  ipAddress?: string;
}) {
  const r2 = getR2Config();
  if (!r2.bucket) throw new Error("r2_not_configured");
  const url = await getSignedUrl(createR2Client(), new GetObjectCommand({
    Bucket: r2.bucket,
    Key: input.key,
  }), { expiresIn: input.expiresInSeconds ?? 300 });

  try {
    await db.insert(fileAccessLogsTable).values({
      companyId: input.companyId,
      userId: input.userId ?? null,
      r2Key: input.key,
      action: "signed_url.created",
      ipAddress: input.ipAddress,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : "unknown" }, "File access log write failed");
  }

  return url;
}
