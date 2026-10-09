"""Bank statement row extractor — normalizes parsed CSV/Excel rows to BankRow schema."""
from typing import Any, Optional
from ..parsers.normalize import (
    column_value, normalize_amount, normalize_date,
    BANK_DATE_ALIASES, BANK_NARRATION_ALIASES,
    BANK_DEBIT_ALIASES, BANK_CREDIT_ALIASES,
    BANK_BALANCE_ALIASES, BANK_REFERENCE_ALIASES,
)
from ..models.extraction import BankRow


def _dr_cr_heuristic(narration: str, debit_raw: Optional[str], credit_raw: Optional[str]) -> str:
    """Determine DR/CR from narration and raw cell values."""
    narr = (narration or "").upper()
    if any(t in narr for t in ("DEBIT", " DR ", "NEFT DR", "UPI DR", "IMPS DR", "ATM")):
        return "debit"
    if any(t in narr for t in ("CREDIT", " CR ", "NEFT CR", "UPI CR", "RTGS")):
        return "credit"
    if debit_raw and normalize_amount(debit_raw):
        return "debit"
    if credit_raw and normalize_amount(credit_raw):
        return "credit"
    return "unknown"


def extract_bank_rows(raw_rows: list[dict[str, Any]], file_name: str = "", bank_name: str = "") -> list[dict[str, Any]]:
    """
    Convert raw parsed rows → normalized BankRow dicts.

    Rules:
    - Never return blank rows if source has values.
    - Skip header-only / running-balance-only rows.
    - Preserve row_number.
    """
    results = []
    skip_patterns = {"opening balance", "closing balance", "total", "brought forward", "carried forward"}

    for row in raw_rows:
        row_num = row.get("_row_number", 0)

        date_raw = column_value(row, BANK_DATE_ALIASES)
        if not date_raw:
            continue  # rows without date skipped
        date = normalize_date(date_raw) or date_raw

        narration = column_value(row, BANK_NARRATION_ALIASES) or ""

        # Skip summary lines
        narr_lower = narration.lower().strip()
        if any(p in narr_lower for p in skip_patterns):
            continue

        debit_raw = column_value(row, BANK_DEBIT_ALIASES)
        credit_raw = column_value(row, BANK_CREDIT_ALIASES)
        balance_raw = column_value(row, BANK_BALANCE_ALIASES)
        reference = column_value(row, BANK_REFERENCE_ALIASES)

        debit = normalize_amount(debit_raw) if debit_raw else None
        credit = normalize_amount(credit_raw) if credit_raw else None
        balance = normalize_amount(balance_raw) if balance_raw else None

        # Some banks use a single "Amount" column with +/- sign
        if debit is None and credit is None:
            amount_raw = column_value(row, ["amount", "transaction amount", "txn amount", "dr/cr amount"])
            if amount_raw:
                amt = normalize_amount(amount_raw)
                if amt is not None:
                    if amt < 0:
                        debit = abs(amt)
                    else:
                        credit = amt

        # Skip rows with no financial data at all
        if debit is None and credit is None:
            continue

        bank_row = BankRow(
            date=date,
            description=narration or None,
            narration=narration or None,
            reference=reference,
            debit=debit,
            credit=credit,
            balance=balance,
            bank_name=bank_name or None,
            row_number=row_num,
            confidence=0.95 if (date and narration and (debit or credit)) else 0.7,
            source_file=file_name or None,
        )
        results.append(bank_row.model_dump())

    return results
