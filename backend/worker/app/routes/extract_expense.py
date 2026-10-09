"""Expense extraction route."""
from fastapi import APIRouter, File, UploadFile, Form
from ..parsers.csv_parser import parse_csv
from ..parsers.normalize import column_value, normalize_amount, normalize_date
from ..models.extraction import ExtractionResponse

router = APIRouter()


@router.post("/extract/expense", response_model=ExtractionResponse)
async def extract_expense(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
    upload_id: int | None = Form(None),
    run_id: str | None = Form(None),
):
    """Extract expense sheet rows. Expense → bank_transactions as debit entries."""
    content = await file.read()
    parsed = parse_csv(content, file.filename or "expense.csv")
    rows = []
    for row in parsed["rows"]:
        date = normalize_date(column_value(row, ["date", "expense date", "txn date"]) or "")
        description = column_value(row, ["description", "expense", "particulars", "details", "narration", "remarks", "purpose"])
        amount_raw = column_value(row, ["amount", "expense amount", "value", "cost", "debit"])
        amount = normalize_amount(amount_raw or "")
        if not date or amount is None:
            continue
        rows.append({
            "date": date,
            "narration": description,
            "description": description,
            "reference": column_value(row, ["reference", "bill no", "receipt no", "invoice no"]),
            "debit": abs(amount),
            "credit": None,
            "balance": None,
            "source_type": "expenses",
            "category": column_value(row, ["category", "type", "head"]),
            "row_number": row.get("_row_number"),
            "confidence": 0.9,
        })
    return ExtractionResponse(
        ok=bool(rows),
        source_type="expenses",
        extraction_method="csv_column_match",
        confidence=0.9 if rows else 0.0,
        rows=rows,
        warnings=[],
        errors=[] if rows else ["No expense rows found. Expected columns: Date, Description/Particulars, Amount."],
        metadata={
            "detected_columns": parsed.get("detected_columns", []),
            "raw_row_count": parsed["row_count"],
            "normalized_row_count": len(rows),
        },
    )
