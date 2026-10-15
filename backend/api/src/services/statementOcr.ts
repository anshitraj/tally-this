/**
 * Bounded OCR for scanned bank statements.
 * Output is extraction pending review. It is not verified books.
 * If no OCR engine is configured, this fails closed and creates no transactions.
 *
 * Pages are read a few at a time, one per spare CPU core, and joined in page order. If any page
 * cannot be read nothing is returned: a statement with a missing page must never look complete.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "../lib/uploadLimit";
import { OCR_BUDGET_MS, OCR_MAX_PAGES, OCR_PAGES_IN_FLIGHT, OCR_PAGE_FAILURES_BEFORE_STOP, pageRanges } from "./statementReadPlan";

const TIMEOUT_MS = 20_000;

export interface OcrPage {
  /** 1-based page number in the PDF. 1 for an image. */
  page: number;
  text: string;
}

export interface OcrSuccess {
  available: true;
  /** The text of every page read, in page order. */
  text: string;
  pages: OcrPage[];
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

function run(command: string, args: string[], opts?: { env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, env: opts?.env ? { ...process.env, ...opts.env } : process.env });
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

type Rasterizer = "pdftoppm" | "magick";

/** Which tool turns a PDF page into an image, or null when neither is installed. */
async function pickRasterizer(): Promise<Rasterizer | null> {
  if (!(await run("pdftoppm", ["-v"])).missing) return "pdftoppm";
  if (!(await run("magick", ["-version"])).missing) return "magick";
  return null;
}

/** One page of a PDF as a PNG, or null when it could not be rendered. */
async function rasterizePage(tool: Rasterizer, pdfPath: string, page: number, dir: string): Promise<string | null> {
  const prefix = path.join(dir, `page-${page}`);
  const result = tool === "pdftoppm"
    ? await run("pdftoppm", ["-png", "-singlefile", "-f", String(page), "-l", String(page), pdfPath, prefix])
    : await run("magick", ["-density", "200", `${pdfPath}[${page - 1}]`, `${prefix}.png`]);
  return result.missing || result.code !== 0 ? null : `${prefix}.png`;
}

/** Runs `work` for every item with at most `size` in flight. */
async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

export async function recognizeStatement(input: {
  buffer: Buffer;
  fileName: string;
  kind: "image" | "pdf";
  /** Pages in the PDF. Needed for a PDF unless `pages` is given. */
  pageCount?: number;
  /** 1-based pages to read. Default: every page. Pages that already have a text layer are left out. */
  pages?: number[];
  /** Called after each page, with pages finished and pages to read. */
  onProgress?: (done: number, total: number) => void;
}): Promise<OcrOutcome> {
  if (!input.buffer?.length) {
    return unavailable("OCR unavailable. The file is stored as metadata only. No transactions were created.");
  }
  let wanted: number[] = [1];
  if (input.kind === "pdf") {
    const explicit = [...new Set((input.pages ?? []).filter(page => Number.isInteger(page) && page > 0))].sort((a, b) => a - b);
    if (explicit.length > 0) wanted = explicit;
    else if (input.pageCount && input.pageCount > 0) wanted = Array.from({ length: input.pageCount }, (_, index) => index + 1);
    else return unavailable("OCR unavailable. The number of pages in this scan is not known, so a partial statement was not created.");
    if (wanted.length > OCR_MAX_PAGES) {
      return unavailable(`OCR unavailable. This scan needs ${wanted.length} pages read and OCR here reads at most ${OCR_MAX_PAGES}, so a partial statement was not created.`);
    }
  }
  if (input.buffer.length > MAX_UPLOAD_BYTES) {
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

    let rasterizer: Rasterizer | null = null;
    if (input.kind === "pdf") {
      rasterizer = await pickRasterizer();
      if (!rasterizer) return unavailable("OCR unavailable. This scanned PDF could not be rendered. No transactions were created.");
    }

    // Tesseract threads itself; with several pages in flight one thread each avoids fighting over cores.
    const env = OCR_PAGES_IN_FLIGHT > 1 ? { OMP_THREAD_LIMIT: "1" } : undefined;
    const results = new Map<number, string>();
    const failed: number[] = [];
    const deadline = Date.now() + OCR_BUDGET_MS;
    let finished = 0;
    let stopped = false;

    await inPool(wanted, OCR_PAGES_IN_FLIGHT, async page => {
      if (stopped || Date.now() > deadline) {
        failed.push(page);
        return;
      }
      let image: string | null = sourcePath;
      if (input.kind === "pdf" && rasterizer) image = await rasterizePage(rasterizer, sourcePath, page, dir);
      let text: string | null = null;
      if (image) {
        const read = await run(tesseractBin(), [image, "stdout", "-l", "eng"], { env });
        if (!read.missing && read.code === 0) text = read.stdout.trim();
        if (input.kind === "pdf") await rm(image, { force: true }).catch(() => undefined);
      }
      if (text == null) failed.push(page);
      else results.set(page, text);
      finished += 1;
      input.onProgress?.(finished, wanted.length);
      // Nothing is being read at all (engine broken, file unreadable): stop spending time on the rest.
      if (results.size === 0 && failed.length >= OCR_PAGE_FAILURES_BEFORE_STOP) stopped = true;
    });

    if (failed.length > 0) {
      const list = pageRanges(failed);
      return unavailable(`OCR unavailable. Page${failed.length === 1 ? "" : "s"} ${list} of this scan could not be read, so a partial statement was not created.`);
    }
    const pages: OcrPage[] = wanted.map(page => ({ page, text: results.get(page) ?? "" }));
    const text = pages.map(page => page.text).filter(Boolean).join("\n").trim();
    if (!text) {
      return unavailable("OCR unavailable. The scan did not produce text. No transactions were created.");
    }
    return { available: true, text, pages, engine: "tesseract", reviewState: "ocr_pending_review" };
  } catch {
    return unavailable("OCR unavailable. The file is stored as metadata only. No transactions were created.");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
