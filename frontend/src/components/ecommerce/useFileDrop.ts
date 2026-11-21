import { useEffect, useRef, useState } from "react";

/** True when what is being dragged includes files (not text or a link from the page). */
function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Lets a whole page take dropped files: anywhere on the window, not only a box. `dragging` is true while files are held
 * over the page, so it can show where they will go. Nothing happens when `enabled` is false.
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = 0;
      setDragging(false);
      // A drop box on the page already took these files.
      if (event.defaultPrevented) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) handler.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}

export const REPORT_FILE = /\.(xlsx|xls|csv|zip)$/i;

/** Meesho's own GST report names, so a file dropped on Home can go straight to the Meesho workspace. */
export const MEESHO_REPORT_NAME = /^(tcs_sales(_return)?|tax_invoice_details)([^a-z].*)?\.(xlsx|xls|csv|zip)$/i;
