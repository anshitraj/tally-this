"""Column name and value normalization for Indian bank/tally/GST files."""
import re
from typing import Any, Optional


# ── Key normalization ─────────────────────────────────────────────────────────

def normalize_key(key: str) -> str:
    """Strip non-alphanumeric, lowercase: 'Debit Amt (INR)' → 'debitamtinr'"""
    return re.sub(r"[^a-z0-9]", "", key.lower())


def column_value(row: dict[str, Any], aliases: list[str]) -> Optional[str]:
    """
    Multi-pass column lookup:
    1. Exact normalized match
    2. Alias contained in key
    3. Key contained in alias
    Returns first non-empty string found.
    """
    normalized_aliases = [normalize_key(a) for a in aliases if len(normalize_key(a)) >= 2]
    entries = list(row.items())

    # Pass 1: exact
    for k, v in entries:
        nk = normalize_key(k)
        if nk in normalized_aliases:
            s = str(v or "").strip()
            if s:
                return s

    # Pass 2: alias substring of key or key substring of alias
    for k, v in entries:
        nk = normalize_key(k)
        if len(nk) < 2:
            continue
        for alias in normalized_aliases:
            if len(alias) < 3:
                continue
            if alias in nk or nk in alias:
                s = str(v or "").strip()
                if s:
                    return s

    return None


# ── Amount normalization ──────────────────────────────────────────────────────

_AMOUNT_CLEAN = re.compile(r"[₹,\s]|INR|Rs\.?", re.IGNORECASE)
_PARENS_NEG = re.compile(r"^\((.+)\)$")


def normalize_amount(raw: str) -> Optional[float]:
    """
    'Rs. 1,23,456.78' → 123456.78
    '(5000.00)'       → -5000.0  (debit in bracket notation)
    '''                → None
    """
    if not raw or not raw.strip():
        return None
    s = _AMOUNT_CLEAN.sub("", raw).strip()
    neg = _PARENS_NEG.match(s)
    if neg:
        s = "-" + neg.group(1)
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


# ── Date normalization ────────────────────────────────────────────────────────

_DATE_PATTERNS = [
    # ISO
    (re.compile(r"^(\d{4})-(\d{2})-(\d{2})$"), "{0}-{1}-{2}"),
    # DD/MM/YYYY or DD-MM-YYYY
    (re.compile(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$"), "{2}-{1:02d}-{0:02d}"),
    # DD MMM YYYY  "01 May 2026"
    (re.compile(r"^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$"), None),
]

_MONTH_MAP = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def normalize_date(raw: str) -> Optional[str]:
    """Return ISO date YYYY-MM-DD or None."""
    if not raw:
        return None
    raw = raw.strip()

    # ISO already
    m = _DATE_PATTERNS[0][0].match(raw)
    if m:
        return raw

    # DD/MM/YYYY
    m = _DATE_PATTERNS[1][0].match(raw)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), m.group(3)
        if 1 <= mo <= 12:
            return f"{y}-{mo:02d}-{d:02d}"

    # DD MMM YYYY
    m = _DATE_PATTERNS[2][0].match(raw)
    if m:
        d_str, mon_str, y = m.group(1), m.group(2).lower()[:3], m.group(3)
        mo = _MONTH_MAP.get(mon_str)
        if mo:
            return f"{y}-{mo}-{int(d_str):02d}"

    return None


# ── Bank column aliases ───────────────────────────────────────────────────────

BANK_DATE_ALIASES = [
    "date", "txn date", "transaction date", "value date", "posting date",
    "txn dt", "trans date", "tran dt",
]

BANK_NARRATION_ALIASES = [
    "narration", "description", "particulars", "details", "remarks",
    "transaction description", "transaction remarks", "chq/ref no description",
]

BANK_DEBIT_ALIASES = [
    "debit", "dr", "withdrawal", "withdrawal amt", "withdrawal amount",
    "withdrawal amt (inr)", "debit amt", "debit amount", "debit (dr)",
    "debit amt (inr)", "dr amount", "debit amount (inr)",
]

BANK_CREDIT_ALIASES = [
    "credit", "cr", "deposit", "deposit amt", "deposit amount",
    "deposit amt (inr)", "credit amt", "credit amount", "credit (cr)",
    "credit amt (inr)", "cr amount", "credit amount (inr)",
]

BANK_BALANCE_ALIASES = [
    "balance", "closing balance", "running balance", "bal",
    "balance (inr)", "available balance",
]

BANK_REFERENCE_ALIASES = [
    "reference", "ref", "utr", "utr no", "utr number",
    "chq no", "chq number", "chq/ref no", "cheque no",
    "transaction id", "txn id", "trnxn id",
]

# ── Tally column aliases ──────────────────────────────────────────────────────

TALLY_DATE_ALIASES = [
    "date", "voucher date", "vch date", "posting date",
]

TALLY_LEDGER_ALIASES = [
    "ledger", "ledger name", "account", "account name",
    "particulars", "party", "party name",
    "narration", "description",
]

TALLY_VOUCHER_NO_ALIASES = [
    "voucher", "voucher no", "voucher number", "vch no",
    "reference", "ref no",
]

TALLY_DEBIT_ALIASES = [
    "debit", "dr", "dr amount", "debit amount", "debit amt", "debit (dr)",
]

TALLY_CREDIT_ALIASES = [
    "credit", "cr", "cr amount", "credit amount", "credit amt", "credit (cr)",
]

TALLY_AMOUNT_ALIASES = [
    "amount", "voucher amount", "transaction amount", "value",
]
