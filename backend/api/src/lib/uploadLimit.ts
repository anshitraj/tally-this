/** Largest file the job pages accept. A 150-page scanned statement is often 20 to 50 MB. */
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 60;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
