/**
 * A small, strict ZIP reader for report bundles (Meesho's GST report download is a ZIP).
 *
 * It reads the central directory, never trusts the declared sizes alone, and inflates each member with a hard output
 * cap, so a ZIP bomb fails instead of filling memory. Encrypted, ZIP64 and nested archives are refused with a plain
 * message, and member names can never point outside the archive.
 */
import { inflateRawSync } from "node:zlib";

export const ZIP_LIMITS = {
  maxEntries: 50,
  maxEntryBytes: 60 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxRatio: 200,
};

export class ZipError extends Error {}

export interface ZipEntry { name: string; data: Buffer }

export function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 65_535);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function readZip(buffer: Buffer, limits = ZIP_LIMITS): { entries: ZipEntry[]; skipped: string[] } {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new ZipError("This ZIP file is damaged or incomplete.");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("This ZIP uses a format (ZIP64) that is not supported. Extract it and upload the files.");
  if (count > limits.maxEntries) throw new ZipError(`This ZIP has ${count} files; at most ${limits.maxEntries} are read from one ZIP.`);
  if (cdOffset + cdSize > buffer.length) throw new ZipError("This ZIP file is damaged or incomplete.");

  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new ZipError("This ZIP file is damaged or incomplete.");
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLength + extraLength + commentLength;

    const name = rawName.replace(/\\/g, "/");
    if (name.endsWith("/")) continue; // a folder
    const base = name.split("/").pop() ?? name;
    if (name.startsWith("/") || name.split("/").includes("..") || /^[a-zA-Z]:/.test(name)) {
      skipped.push(`${base}: unsafe path, not read`);
      continue;
    }
    if (base.startsWith(".") || name.startsWith("__MACOSX/")) continue;
    if (flags & 0x1) throw new ZipError(`"${base}" inside the ZIP is password-protected. Extract it with the password and upload the file itself.`);
    if (/\.zip$/i.test(base)) {
      skipped.push(`${base}: a ZIP inside a ZIP is not opened`);
      continue;
    }
    if (size > limits.maxEntryBytes) throw new ZipError(`"${base}" inside the ZIP is larger than ${Math.round(limits.maxEntryBytes / 1024 / 1024)} MB.`);
    if (compressedSize > 0 && size / compressedSize > limits.maxRatio) throw new ZipError(`"${base}" inside the ZIP expands too much to be a report; it was not opened.`);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError("This ZIP file is damaged or incomplete.");
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const compressed = buffer.subarray(start, start + compressedSize);
    if (compressed.length !== compressedSize) throw new ZipError("This ZIP file is damaged or incomplete.");

    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.min(limits.maxEntryBytes, Math.max(size, 1)) + 1 });
      } catch {
        throw new ZipError(`"${base}" inside the ZIP could not be opened; it may be damaged or larger than it claims.`);
      }
    } else {
      skipped.push(`${base}: compressed with a method that is not supported`);
      continue;
    }
    if (data.length !== size) throw new ZipError(`"${base}" inside the ZIP is not the size the ZIP says; it was not read.`);
    total += data.length;
    if (total > limits.maxTotalBytes) throw new ZipError(`The files inside this ZIP add up to more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB.`);
    entries.push({ name: base, data });
  }
  return { entries, skipped };
}
