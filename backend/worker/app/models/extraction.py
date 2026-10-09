"""Pydantic models for extraction requests and normalized row outputs."""
from typing import Any, Optional
from pydantic import BaseModel, field_validator


# ── Request ─────────────────────────────────────────────────────────────────

class ParseRequest(BaseModel):
    """Common parse/extract request."""
    source_type: str
    company_id: Optional[int] = None
    upload_id: Optional[int] = None
    run_id: Optional[str] = None
    file_name: Optional[str] = None
    # One of the three must be set:
    file_path: Optional[str] = None          # local dev path
    storage_key: Optional[str] = None        # R2/S3 key
    signed_url: Optional[str] = None         # temporary URL
    options: dict[str, Any] = {}


# ── Normalized row types ─────────────────────────────────────────────────────

class BankRow(BaseModel):
    date: Optional[str] = None
    value_date: Optional[str] = None
    description: Optional[str] = None
    narration: Optional[str] = None
    reference: Optional[str] = None
    debit: Optional[float] = None
    credit: Optional[float] = None
    balance: Optional[float] = None
    counterparty: Optional[str] = None
    account_name: Optional[str] = None
    account_number_masked: Optional[str] = None
    bank_name: Optional[str] = None
    row_number: Optional[int] = None
    confidence: float = 1.0
    source_file: Optional[str] = None
    source_page: Optional[int] = None
    source_quote: Optional[str] = None


class TallyRow(BaseModel):
    voucher_date: Optional[str] = None
    voucher_no: Optional[str] = None
    voucher_type: Optional[str] = None
    ledger_name: Optional[str] = None
    party_name: Optional[str] = None
    narration: Optional[str] = None
    reference: Optional[str] = None
    invoice_no: Optional[str] = None
    debit: Optional[float] = None
    credit: Optional[float] = None
    amount: Optional[float] = None
    dr_cr: Optional[str] = None
    row_number: Optional[int] = None
    confidence: float = 1.0
    source_file: Optional[str] = None
    source_page: Optional[int] = None
    source_quote: Optional[str] = None


class GatewayRow(BaseModel):
    settlement_id: Optional[str] = None
    provider: Optional[str] = None
    gross_amount: Optional[float] = None
    fees: Optional[float] = None
    gst_on_fees: Optional[float] = None
    net_amount: Optional[float] = None
    settlement_date: Optional[str] = None
    bank_reference: Optional[str] = None
    row_number: Optional[int] = None
    confidence: float = 1.0
    source_file: Optional[str] = None


class GstRow(BaseModel):
    period: Optional[str] = None
    source_type: str = "uploaded_gst"
    gstin: Optional[str] = None
    counterparty_name: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    taxable_value: Optional[float] = None
    igst: Optional[float] = None
    cgst: Optional[float] = None
    sgst: Optional[float] = None
    gst_amount: Optional[float] = None
    row_number: Optional[int] = None
    confidence: float = 1.0


class PayrollRow(BaseModel):
    employee_name: Optional[str] = None
    month: Optional[str] = None
    gross_amount: Optional[float] = None
    net_amount: Optional[float] = None
    payment_date: Optional[str] = None
    bank_reference: Optional[str] = None
    row_number: Optional[int] = None
    confidence: float = 1.0


class InvoiceExtraction(BaseModel):
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    vendor_name: Optional[str] = None
    vendor_gstin: Optional[str] = None
    customer_name: Optional[str] = None
    customer_gstin: Optional[str] = None
    subtotal: Optional[float] = None
    gst_amount: Optional[float] = None
    total_amount: Optional[float] = None
    line_items: list[dict[str, Any]] = []
    confidence: float = 0.0
    missing_fields: list[str] = []
    warnings: list[str] = []
    source_quotes: list[str] = []


# ── Response ─────────────────────────────────────────────────────────────────

class ExtractionResponse(BaseModel):
    ok: bool
    source_type: str
    extraction_method: str  # csv_column_match | excel_header_scan | pdf_text | pdf_table | vision_ai | ocr | ai_gemini | manual_required
    confidence: float = 1.0
    rows: list[dict[str, Any]] = []
    invoice: Optional[InvoiceExtraction] = None
    row_count: int = 0
    warnings: list[str] = []
    errors: list[str] = []
    metadata: dict[str, Any] = {}

    @field_validator("row_count", mode="before")
    @classmethod
    def compute_row_count(cls, v, info):
        # auto-set from rows if 0
        data = info.data
        rows = data.get("rows", [])
        return v if v else len(rows)
