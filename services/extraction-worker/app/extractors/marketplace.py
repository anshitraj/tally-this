"""Marketplace sales normalizer. Draft figures only — not a GST determination."""
from typing import Any

from ..parsers.normalize import column_value, normalize_amount, normalize_date


def extract_marketplace_rows(raw_rows: list[dict[str, Any]], platform: str, file_name: str = "") -> list[dict[str, Any]]:
    sales = []
    for row in raw_rows:
        taxable = abs(normalize_amount(column_value(row, ["taxable value", "taxable", "item price"]) or "") or 0)
        cgst = abs(normalize_amount(column_value(row, ["cgst"]) or "") or 0)
        sgst = abs(normalize_amount(column_value(row, ["sgst"]) or "") or 0)
        igst = abs(normalize_amount(column_value(row, ["igst"]) or "") or 0)
        gross = normalize_amount(column_value(row, ["gross amount", "invoice amount", "invoice value"]) or "")
        invoice = column_value(row, ["invoice number", "invoice no", "invoice"])
        if gross is None:
            gross = taxable + cgst + sgst + igst
        if not invoice and gross == 0:
            continue
        issues = []
        hsn = column_value(row, ["hsn"])
        if not hsn:
            issues.append("Missing HSN. Potential risk — needs CA review.")
        sales.append({
            "platform": platform,
            "order_id": column_value(row, ["order id", "order-id", "order no"]),
            "invoice_number": invoice,
            "invoice_date": normalize_date(column_value(row, ["invoice date", "order date", "date"]) or ""),
            "gstin": column_value(row, ["buyer gstin", "gstin", "customer gstin"]),
            "buyer_state": column_value(row, ["buyer state", "ship state", "state"]),
            "place_of_supply": column_value(row, ["place of supply", "pos"]) or column_value(row, ["buyer state", "state"]),
            "taxable_value": taxable,
            "cgst": cgst,
            "sgst": sgst,
            "igst": igst,
            "cess": abs(normalize_amount(column_value(row, ["cess"]) or "") or 0),
            "gross_amount": abs(gross or 0),
            "refund_amount": abs(normalize_amount(column_value(row, ["refund amount", "refund"]) or "") or 0),
            "marketplace_fees": abs(normalize_amount(column_value(row, ["marketplace fees", "fee", "commission"]) or "") or 0),
            "tcs_amount": abs(normalize_amount(column_value(row, ["tcs amount", "tcs"]) or "") or 0),
            "hsn": hsn,
            "gst_rate": normalize_amount(column_value(row, ["gst rate", "tax rate", "rate"]) or ""),
            "transaction_type": (column_value(row, ["transaction type", "type"]) or "sale").lower(),
            "source_file": file_name,
            "source_row": row.get("_row_number"),
            "issues": issues,
            "confidence": 0.9 if not issues else 0.6,
        })
    return sales
