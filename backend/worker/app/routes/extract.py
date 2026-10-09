"""FastAPI extract routes — POST /extract/{source-type}."""
from fastapi import APIRouter, File, UploadFile, Form, HTTPException

from ..parsers.csv_parser import parse_csv
from ..extractors.bank import extract_bank_rows
from ..extractors.tally import extract_tally_rows
from ..extractors.marketplace import extract_marketplace_rows
from ..models.extraction import ExtractionResponse

router = APIRouter(prefix="/extract", tags=["extract"])


async def _read_upload(file: UploadFile) -> bytes:
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")
    return content


@router.post("/bank-statement", response_model=ExtractionResponse)
async def extract_bank(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
    bank_name: str | None = Form(None),
):
    content = await _read_upload(file)
    fname = file.filename or "bank.csv"

    parsed = parse_csv(content, fname)
    if not parsed["rows"]:
        return ExtractionResponse(
            ok=False, source_type="bank_statement",
            extraction_method="csv_column_match", confidence=0.0,
            rows=[], errors=["No rows found after parsing."],
            warnings=parsed.get("warnings", []),
            metadata={"detected_columns": parsed.get("detected_columns", [])},
        )

    norm = extract_bank_rows(parsed["rows"], fname, bank_name or "")
    return ExtractionResponse(
        ok=bool(norm), source_type="bank_statement",
        extraction_method="csv_column_match",
        confidence=0.95 if norm else 0.0,
        rows=norm,
        warnings=[] if norm else ["0 importable bank rows. Check column names (Date, Narration/Description, Debit, Credit, Balance, Reference)."],
        errors=[] if norm else ["No bank rows could be normalized from this file."],
        metadata={
            "detected_columns": parsed.get("detected_columns", []),
            "raw_row_count": parsed["row_count"],
            "normalized_row_count": len(norm),
        },
    )


@router.post("/tally-ledger", response_model=ExtractionResponse)
async def extract_tally(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
):
    content = await _read_upload(file)
    fname = file.filename or "tally.csv"

    parsed = parse_csv(content, fname)
    if not parsed["rows"]:
        return ExtractionResponse(
            ok=False, source_type="tally_export",
            extraction_method="csv_column_match", confidence=0.0,
            rows=[], errors=["No rows found."],
            warnings=parsed.get("warnings", []),
            metadata={},
        )

    norm = extract_tally_rows(parsed["rows"], fname)
    return ExtractionResponse(
        ok=bool(norm), source_type="tally_export",
        extraction_method="csv_column_match",
        confidence=0.95 if norm else 0.0,
        rows=norm,
        warnings=[] if norm else ["0 importable Tally rows. Expected columns: Date, Ledger/Account, Debit, Credit, Voucher No."],
        errors=[] if norm else ["No Tally rows normalized."],
        metadata={
            "detected_columns": parsed.get("detected_columns", []),
            "raw_row_count": parsed["row_count"],
            "normalized_row_count": len(norm),
        },
    )


@router.post("/invoice", response_model=ExtractionResponse)
async def extract_invoice(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
):
    """Invoice extraction — AI-first. Always pending review. Never auto-verified."""
    content = await _read_upload(file)
    fname = file.filename or "invoice.pdf"

    # Try pdfplumber text first
    text = ""
    try:
        import pdfplumber, io
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            text = "\n".join(p.extract_text() or "" for p in pdf.pages)
    except Exception:
        pass

    if not text.strip():
        return ExtractionResponse(
            ok=False, source_type="invoices",
            extraction_method="manual_required",
            confidence=0.0, rows=[],
            warnings=["PDF appears scanned or image-based. OCR or AI Vision required."],
            errors=["Cannot extract text from this PDF. Use AI extraction path."],
            metadata={"text_length": 0},
        )

    # Try Gemini AI extraction
    from ..ai.gemini_extract import extract_invoice_via_gemini
    result = await extract_invoice_via_gemini(text, fname)

    return ExtractionResponse(
        ok=result.get("ok", False),
        source_type="invoices",
        extraction_method=result.get("extraction_method", "ai_gemini"),
        confidence=result.get("confidence", 0.0),
        rows=[],
        invoice=result.get("invoice"),
        warnings=result.get("warnings", ["AI extracted — pending review"]),
        errors=result.get("errors", []),
        metadata={"text_length": len(text), "status": "pending_review"},
    )


@router.post("/gst-tds", response_model=ExtractionResponse)
async def extract_gst(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
):
    content = await _read_upload(file)
    fname = file.filename or "gst.csv"

    parsed = parse_csv(content, fname)
    # Minimal GST normalization (GSTIN + invoice + tax)
    from ..parsers.normalize import column_value, normalize_amount, normalize_date
    rows = []
    for row in parsed["rows"]:
        gstin = column_value(row, ["gstin", "counterparty gstin", "ctin", "supplier gstin"])
        inv_no = column_value(row, ["invoice number", "invoice no", "inum", "bill no"])
        inv_date = column_value(row, ["invoice date", "date"])
        taxable = normalize_amount(column_value(row, ["taxable value", "taxable", "value"]) or "") or 0
        igst = normalize_amount(column_value(row, ["igst", "integrated gst"]) or "") or 0
        cgst = normalize_amount(column_value(row, ["cgst", "central gst"]) or "") or 0
        sgst = normalize_amount(column_value(row, ["sgst", "state gst", "utgst"]) or "") or 0
        gst_total = normalize_amount(column_value(row, ["gst amount", "gst", "tax amount"]) or "") or (igst + cgst + sgst)

        if not invoice_number_valid(inv_no) and taxable == 0 and gst_total == 0:
            continue

        rows.append({
            "gstin": gstin,
            "counterparty_name": column_value(row, ["counterparty", "counterparty name", "supplier", "party name"]),
            "invoice_number": inv_no,
            "invoice_date": normalize_date(inv_date or ""),
            "taxable_value": taxable,
            "igst": igst,
            "cgst": cgst,
            "sgst": sgst,
            "gst_amount": gst_total,
            "row_number": row.get("_row_number"),
            "confidence": 0.9,
        })

    return ExtractionResponse(
        ok=bool(rows), source_type="gst_tds",
        extraction_method="csv_column_match",
        confidence=0.9 if rows else 0.0,
        rows=rows, warnings=[], errors=[] if rows else ["No GST rows found."],
        metadata={"raw_row_count": parsed["row_count"], "normalized_row_count": len(rows)},
    )


def invoice_number_valid(val):
    return val and len(str(val).strip()) >= 2


@router.post("/payroll", response_model=ExtractionResponse)
async def extract_payroll(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
):
    content = await _read_upload(file)
    parsed = parse_csv(content, file.filename or "payroll.csv")
    from ..parsers.normalize import column_value, normalize_amount, normalize_date
    rows = []
    for row in parsed["rows"]:
        emp = column_value(row, ["employee", "employee name", "name", "staff name"])
        month = column_value(row, ["month", "pay month", "salary month", "period"])
        net = normalize_amount(column_value(row, ["net amount", "net salary", "net pay", "amount"]) or "")
        if not emp or net is None:
            continue
        rows.append({
            "employee_name": emp,
            "month": month,
            "gross_amount": normalize_amount(column_value(row, ["gross amount", "gross salary", "gross pay"]) or ""),
            "net_amount": net,
            "payment_date": normalize_date(column_value(row, ["payment date", "paid date", "date"]) or ""),
            "bank_reference": column_value(row, ["bank reference", "reference", "utr"]),
            "row_number": row.get("_row_number"),
            "confidence": 0.95,
        })
    return ExtractionResponse(
        ok=bool(rows), source_type="payroll",
        extraction_method="csv_column_match",
        confidence=0.95 if rows else 0.0,
        rows=rows, warnings=[], errors=[] if rows else ["No payroll rows found."],
        metadata={"raw_row_count": parsed["row_count"], "normalized_row_count": len(rows)},
    )


@router.post("/marketplace", response_model=ExtractionResponse)
async def extract_marketplace(
    file: UploadFile = File(...),
    platform: str = Form("generic"),
):
    content = await _read_upload(file)
    parsed = parse_csv(content, file.filename or "marketplace.csv")
    rows = extract_marketplace_rows(parsed["rows"], platform.lower(), file.filename or "")
    return ExtractionResponse(
        ok=bool(rows),
        source_type="marketplace",
        extraction_method="csv_column_match",
        confidence=0.9 if rows else 0.0,
        rows=rows,
        warnings=["Potential risk — needs CA review. This is not GST portal validation."],
        errors=[] if rows else ["No marketplace rows found."],
        metadata={"raw_row_count": parsed["row_count"], "normalized_row_count": len(rows), "platform": platform},
    )


@router.post("/gateway-statement", response_model=ExtractionResponse)
async def extract_gateway(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
):
    content = await _read_upload(file)
    parsed = parse_csv(content, file.filename or "gateway.csv")
    from ..parsers.normalize import column_value, normalize_amount, normalize_date
    # Detect provider from filename
    fname = (file.filename or "").lower()
    provider = "Razorpay" if "razorpay" in fname else "Cashfree" if "cashfree" in fname else "Stripe" if "stripe" in fname else "Gateway"
    rows = []
    for row in parsed["rows"]:
        sid = column_value(row, ["settlement id", "settlement_id", "id", "reference", "payout id", "transaction id"])
        net = normalize_amount(column_value(row, ["net amount", "settled amount", "amount", "net", "payout amount"]) or "")
        date = normalize_date(column_value(row, ["settlement date", "date", "paid date", "payout date"]) or "")
        if not sid or net is None:
            continue
        rows.append({
            "settlement_id": sid,
            "provider": column_value(row, ["provider", "gateway"]) or provider,
            "gross_amount": normalize_amount(column_value(row, ["gross amount", "gross"]) or "") or net,
            "fees": normalize_amount(column_value(row, ["fees", "fee", "charges"]) or "") or 0.0,
            "gst_on_fees": normalize_amount(column_value(row, ["gst on fees", "tax on fees"]) or ""),
            "net_amount": net,
            "settlement_date": date,
            "bank_reference": column_value(row, ["bank reference", "utr", "reference"]),
            "row_number": row.get("_row_number"),
            "confidence": 0.95,
        })
    return ExtractionResponse(
        ok=bool(rows), source_type="gateway_settlement",
        extraction_method="csv_column_match",
        confidence=0.95 if rows else 0.0,
        rows=rows, warnings=[], errors=[] if rows else ["No gateway rows found."],
        metadata={"raw_row_count": parsed["row_count"], "normalized_row_count": len(rows)},
    )
