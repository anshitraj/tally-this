/**
 * Bounded OCR for scanned bank statements.
 * Output is extraction pending review. It is not verified books.
 * If no OCR engine is configured, this fails closed and creates no transactions.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 3;
const TIMEOUT_MS = 20_000;

export interface OcrSuccess {
  available: true;
  text: string;
  engine: "tesseract";
  reviewState: "ocr_pending_review";
}

export interface OcrUnavailable {
  available: false;
  reason: "OCR unavailable";
  note: string;
}

export type OcrOutcome = OcrSuccess | OcrUnavailable;

function unavailable(note: string): OcrUnavailable {
  return { available: false, reason: "OCR unavailable", note };
}

function tesseractBin() {
  return process.env.TESSERACT_PATH?.trim() || "tesseract";
}

function run(command: string, args: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: opts?.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let missing = false;
    const timer = setTimeout(() => {
      child.kill();
    }, TIMEOUT_MS);
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(0, 200_000);
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      missing = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr, missing: true });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, missing });
    });
  });
}

async function engineReady(): Promise<boolean> {
  const probe = await run(tesseractBin(), ["--version"]);
  return !probe.missing && probe.code === 0;
}

async function rasterizePdf(pdfPath: string, dir: string): Promise<string[]> {
  const prefix = path.join(dir, "page");
  const poppler = await run("pdftoppm", ["-png", "-f", "1", "-l", String(MAX_PAGES), pdfPath, prefix]);
  if (!poppler.missing && poppler.code === 0) {
    return Array.from({ length: MAX_PAGES }, (_, index) => `${prefix}-${index + 1}.png`);
  }
  const magickPrefix = path.join(dir, "page.png");
  const magick = await run("magick", ["-density", "200", `${pdfPath}[0-${MAX_PAGES - 1}]`, magickPrefix]);
  if (!magick.missing && magick.code === 0) {
    return [magickPrefix];
  }
  return [];
}

async function readImage(imagePath: string): Promise<string> {
  const result = await run(tesseractBin(), [imagePath, "stdout", "-l", "eng"]);
  if (result.missing || result.code !== 0) return "";
  return result.stdout.trim();
}

export async function recognizeStatement(input: {
  buffer: Buffer;
  fileName: string;
  kind: "image" | "pdf";
}): Promise<OcrOutcome> {
  if (!input.buffer?.length) {
    return unavailable("OCR unavailable. The file is stored as metadata only. No transactions were created.");
  }
  if (input.buffer.length > MAX_BYTES) {
    return unavailable("OCR unavailable. The scan is too large to read here. No transactions were created.");
  }
  if (!(await engineReady())) {
    return unavailable("OCR unavailable. The file is stored as metadata only. No transactions were created.");
  }

  const dir = await mkdtemp(path.join(tmpdir(), "finverify-ocr-"));
  try {
    const extension = input.kind === "pdf" ? ".pdf" : path.extname(input.fileName) || ".png";
    const sourcePath = path.join(dir, `statement${extension}`);
    await writeFile(sourcePath, input.buffer);

    if (input.kind === "pdf") {
      const rendered = await rasterizePdf(sourcePath, dir);
      if (rendered.length === 0) {
        return unavailable("OCR unavailable. This scanned PDF could not be rendered. No transactions were created.");
      }
    }
    const names = input.kind === "image"
      ? [sourcePath]
      : (await readdir(dir)).filter(name => name.toLowerCase().endsWith(".png")).map(name => path.join(dir, name));
    if (names.length === 0) {
      return unavailable("OCR unavailable. This scanned PDF could not be rendered. No transactions were created.");
    }

    const pages: string[] = [];
    for (const image of names) {
      const text = await readImage(image);
      if (text) pages.push(text);
    }
    const text = pages.join("\n").trim();
    if (!text) {
      return unavailable("OCR unavailable. The scan did not produce text. No transactions were created.");
    }
    return { available: true, text, engine: "tesseract", reviewState: "ocr_pending_review" };
  } catch {
    return unavailable("OCR unavailable. The file is stored as metadata only. No transactions were created.");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
