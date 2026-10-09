import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export type R2Config = {
  configured: boolean;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  publicUrl?: string;
  endpoint?: string;
  region: string;
};

function read(name: string, fallbackName?: string): string | undefined {
  return process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
}

export function getR2Config(): R2Config {
  const accountId = read("CLOUDFLARE_R2_ACCOUNT_ID");
  const endpoint = read("CLOUDFLARE_R2_ENDPOINT", "STORAGE_ENDPOINT")
    || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  const accessKeyId = read("CLOUDFLARE_R2_ACCESS_KEY_ID", "STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = read("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "STORAGE_SECRET_ACCESS_KEY");
  const bucket = read("CLOUDFLARE_R2_BUCKET", "STORAGE_BUCKET");
  return {
    configured: Boolean(endpoint && accessKeyId && secretAccessKey && bucket),
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl: read("CLOUDFLARE_R2_PUBLIC_URL", "STORAGE_PUBLIC_BASE_URL"),
    endpoint,
    region: process.env.STORAGE_REGION || "auto",
  };
}

export function createR2Client(): S3Client {
  const config = getR2Config();
  if (!config.configured || !config.endpoint || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("r2_not_configured");
  }
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function validateR2Connection(): Promise<"ok" | "error"> {
  const config = getR2Config();
  if (!config.configured || !config.bucket) return "error";
  try {
    await createR2Client().send(new HeadBucketCommand({ Bucket: config.bucket }));
    return "ok";
  } catch {
    return "error";
  }
}
