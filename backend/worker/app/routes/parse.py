"""FastAPI parse routes — POST /parse/csv, /parse/excel, /parse/pdf-text, /parse/pdf-table."""
import io
from typing import Any
from fastapi import APIRouter, File, UploadFile, Form, HTTPException

from ..parsers.csv_parser import parse_csv
from ..models.extraction import ExtractionResponse
from ..extractors.bank import extract_bank_rows
from ..extractors.tally import extract_tally_rows

router = APIRouter(prefix="/parse", tags=["parse"])


def _dispatch_rows(source_type: str, rows: list[dict[str, Any]], file_name: str) -> tuple[list[dict[str, Any]], str]:
    """Route raw rows to source-specific extractor, return (normalized_rows, extraction_method)."""
    st = source_type.lower().strip()
    if st in ("bank", "bank_statement"):
        return extract_bank_rows(rows, file_name), "csv_column_match"
    if st in ("tally", "tally_export", "zoho", "zoho_export", "ledger"):
        return extract_tally_rows(rows, file_name), "csv_column_match"
    # Default: return raw rows for other types
    return rows, "csv_column_match"


@router.post("/csv", response_model=ExtractionResponse)
async def parse_csv_upload(
    file: UploadFile = File(...),
    source_type: str = Form("bank"),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
):
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    parsed = parse_csv(content, file.filename or "upload.csv")
    if not parsed["rows"]:
        return ExtractionResponse(
            ok=False,
            source_type=source_type,
            extraction_method="csv_column_match",
            confidence=0.0,
            rows=[],
            warnings=parsed.get("warnings", []),
            errors=["No importable rows found. Check that the file has a header row and data rows."],
            metadata={"detected_columns": parsed.get("detected_columns", []), "raw_row_count": 0},
        )

    norm_rows, method = _dispatch_rows(source_type, parsed["rows"], file.filename or "")

    return ExtractionResponse(
        ok=True,
        source_type=source_type,
        extraction_method=method,
        confidence=0.95,
        rows=norm_rows,
        warnings=parsed.get("warnings", []),
        errors=[],
        metadata={
            "detected_columns": parsed.get("detected_columns", []),
            "raw_row_count": parsed["row_count"],
            "normalized_row_count": len(norm_rows),
            "header_row_index": parsed.get("header_row_index", 0),
        },
    )


@router.post("/excel", response_model=ExtractionResponse)
async def parse_excel_upload(
    file: UploadFile = File(...),
    source_type: str = Form("bank"),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
):
    """Parse Excel (xlsx/xls) with smart header-row detection (scans first 20 rows per sheet)."""
    try:
        import pandas as pd
        import openpyxl  # noqa: F401
    except ImportError:
        raise HTTPException(500, "pandas/openpyxl not installed. Run: pip install pandas openpyxl")

    content = await file.read()
    xf = io.BytesIO(content)

    _FINANCIAL_KWORDS = {
        "date", "narration", "description", "particulars", "debit", "credit",
        "amount", "balance", "ledger", "account", "invoice", "voucher",
        "gstin", "utr", "reference", "chq", "withdrawal", "deposit",
        "employee", "salary", "settlement", "vendor", "party",
    }

    def _score_header(cols: list[str]) -> float:
        hits = sum(1 for c in cols if any(kw in c.lower().replace(" ", "") for kw in _FINANCIAL_KWORDS))
        return hits / max(len(cols), 1)

    # Try all sheets, pick best
    xl = pd.ExcelFile(xf, engine="openpyxl")
    best_df = None
    best_score = -1.0
    best_sheet = ""

    for sheet in xl.sheet_names:
        for header_row in range(20):
            try:
                df = pd.read_excel(xf, sheet_name=sheet, header=header_row, dtype=str, engine="openpyxl")
                if df.empty or len(df.columns) < 2:
                    continue
                score = _score_header(list(df.columns))
                if score > best_score:
                    best_score = score
                    best_df = df
                    best_sheet = sheet
            except Exception:
                continue

    if best_df is None or best_df.empty:
        return ExtractionResponse(
            ok=False,
            source_type=source_type,
            extraction_method="excel_header_scan",
            confidence=0.0,
            rows=[],
            errors=["Could not detect a financial table in this Excel file. Export as CSV and try again."],
            metadata={},
        )

    # Drop fully empty rows
    best_df = best_df.dropna(how="all")
    raw_rows = best_df.fillna("").to_dict(orient="records")
    for i, r in enumerate(raw_rows, start=1):
        r["_row_number"] = i

    norm_rows, method = _dispatch_rows(source_type, raw_rows, file.filename or "")
    method = "excel_header_scan"

    warnings = []
    if best_score < 0.2:
        warnings.append(f"Low financial-keyword score ({best_score:.2f}). Verify column mapping.")

    return ExtractionResponse(
        ok=True,
        source_type=source_type,
        extraction_method=method,
        confidence=max(0.7, best_score),
        rows=norm_rows,
        warnings=warnings,
        errors=[] if norm_rows else ["No importable rows after normalization. Check column names."],
        metadata={
            "sheet": best_sheet,
            "header_score": round(best_score, 3),
            "raw_row_count": len(raw_rows),
            "normalized_row_count": len(norm_rows),
            "detected_columns": list(best_df.columns),
        },
    )


@router.post("/pdf-text")
async def parse_pdf_text(
    file: UploadFile = File(...),
    source_type: str = Form("bank"),
):
    """Extract raw text from PDF. No row normalization — text only."""
    try:
        import pdfplumber
    except ImportError:
        raise HTTPException(500, "pdfplumber not installed. Run: pip install pdfplumber")

    content = await file.read()
    text_pages = []
    total_chars = 0
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for i, page in enumerate(pdf.pages):
            t = page.extract_text() or ""
            text_pages.append({"page": i + 1, "text": t, "chars": len(t)})
            total_chars += len(t)

    full_text = "\n".join(p["text"] for p in text_pages)
    is_scanned = total_chars < 100

    return {
        "ok": not is_scanned,
        "source_type": source_type,
        "extraction_method": "pdf_text",
        "text": full_text[:20000],
        "page_count": len(text_pages),
        "total_chars": total_chars,
        "is_scanned": is_scanned,
        "warnings": ["PDF appears scanned. OCR or AI Vision required."] if is_scanned else [],
    }


@router.post("/pdf-table")
async def parse_pdf_table(
    file: UploadFile = File(...),
    source_type: str = Form("bank"),
):
    """Extract tables from PDF using pdfplumber. Returns rows if tables found."""
    try:
        import pdfplumber
    except ImportError:
        raise HTTPException(500, "pdfplumber not installed")

    content = await file.read()
    all_rows: list[dict[str, Any]] = []
    headers: list[str] = []
    page_count = 0

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if not table or len(table) < 2:
                    continue
                if not headers:
                    headers = [str(c or "").strip() for c in table[0]]
                for row in table[1:]:
                    if not any(c for c in row):
                        continue
                    obj = {headers[i]: str(row[i] or "").strip() for i in range(min(len(headers), len(row)))}
                    obj["_row_number"] = len(all_rows) + 1
                    all_rows.append(obj)

    if not all_rows:
        return {
            "ok": False,
            "source_type": source_type,
            "extraction_method": "pdf_table",
            "rows": [],
            "page_count": page_count,
            "warnings": ["No tables extracted from PDF. File may be scanned or image-based. Use AI extraction."],
        }

    norm_rows, _ = _dispatch_rows(source_type, all_rows, "")

    return {
        "ok": True,
        "source_type": source_type,
        "extraction_method": "pdf_table",
        "rows": norm_rows,
        "row_count": len(norm_rows),
        "page_count": page_count,
        "detected_columns": headers,
        "warnings": [],
    }
