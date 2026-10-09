"""Tally ledger export row extractor."""
from typing import Any, Optional
from ..parsers.normalize import (
    column_value, normalize_amount, normalize_date,
    TALLY_DATE_ALIASES, TALLY_LEDGER_ALIASES, TALLY_VOUCHER_NO_ALIASES,
    TALLY_DEBIT_ALIASES, TALLY_CREDIT_ALIASES, TALLY_AMOUNT_ALIASES,
)
from ..models.extraction import TallyRow


_SKIP = {"total", "grand total", "opening balance", "closing balance"}


def extract_tally_rows(raw_rows: list[dict[str, Any]], file_name: str = "") -> list[dict[str, Any]]:
    """Normalize raw rows to TallyRow dicts."""
    results = []

    for row in raw_rows:
        row_num = row.get("_row_number", 0)

        date_raw = column_value(row, TALLY_DATE_ALIASES)
        if not date_raw:
            continue
        date = normalize_date(date_raw) or date_raw

        ledger = column_value(row, TALLY_LEDGER_ALIASES)
        if not ledger:
            continue
        if any(s in (ledger or "").lower() for s in _SKIP):
            continue

        voucher_no = column_value(row, TALLY_VOUCHER_NO_ALIASES)
        voucher_type = column_value(row, ["voucher type", "vch type", "type"])
        narration = column_value(row, ["narration", "description", "remarks", "particulars"])
        reference = column_value(row, ["reference", "ref no", "invoice no", "bill no"])

        debit_raw = column_value(row, TALLY_DEBIT_ALIASES)
        credit_raw = column_value(row, TALLY_CREDIT_ALIASES)
        amount_raw = column_value(row, TALLY_AMOUNT_ALIASES)
        dr_cr_raw = column_value(row, ["dr/cr", "dr cr", "debit credit", "type"])

        debit = normalize_amount(debit_raw) if debit_raw else None
        credit = normalize_amount(credit_raw) if credit_raw else None
        amount = normalize_amount(amount_raw) if amount_raw else None

        # Infer from dr_cr field
        dr_cr: Optional[str] = None
        if dr_cr_raw:
            drc = dr_cr_raw.strip().upper()
            if drc in ("DR", "DEBIT"):
                dr_cr = "debit"
            elif drc in ("CR", "CREDIT"):
                dr_cr = "credit"

        # If only "amount" given, infer from dr_cr
        if debit is None and credit is None and amount is not None:
            if dr_cr == "debit":
                debit = abs(amount)
            elif dr_cr == "credit":
                credit = abs(amount)

        if debit is None and credit is None and amount is None:
            continue

        trow = TallyRow(
            voucher_date=date,
            voucher_no=voucher_no,
            voucher_type=voucher_type,
            ledger_name=ledger,
            narration=narration or ledger,  # prefer Narration column; fall back to Ledger only if absent
            reference=reference,
            debit=debit,
            credit=credit,
            amount=amount,
            dr_cr=dr_cr,
            row_number=row_num,
            confidence=0.95 if (date and ledger) else 0.7,
            source_file=file_name,
        )
        results.append(trow.model_dump())

    return results
