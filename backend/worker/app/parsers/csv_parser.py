"""CSV parsing — robust Indian bank/tally/GST/payroll/gateway."""
import io
import csv
from typing import Any

from .normalize import normalize_key, BANK_DATE_ALIASES


_FINANCIAL_KEYWORDS = {
    "date", "narration", "description", "particulars", "debit", "credit",
    "amount", "balance", "ledger", "account", "invoice", "voucher",
    "gstin", "gst", "utr", "reference", "chq", "withdrawal", "deposit",
    "employee", "salary", "settlement", "vendor", "party", "payroll",
}


def _financial_score(headers: list[str]) -> float:
    """Score a header row by how many cells are financial keywords."""
    if not headers:
        return 0.0
    # A single-cell row (bank metadata like "HDFC Bank Ltd") is not a header
    if len([h for h in headers if h.strip()]) < 2:
        return 0.0
    nkeys = [normalize_key(h) for h in headers]
    hits = sum(
        1 for nk in nkeys
        if any(kw in nk or nk in kw for kw in _FINANCIAL_KEYWORDS if len(kw) >= 3 and len(nk) >= 3)
    )
    # Require ≥2 hits and ≥3 non-empty cells to qualify as a financial header
    non_empty = sum(1 for h in headers if h.strip())
    if hits < 2 or non_empty < 3:
        return hits / max(len(headers), 1) * 0.3  # low score, won't win
    return hits / max(len(headers), 1)


def parse_csv(content: bytes | str, file_name: str = "") -> dict[str, Any]:
    """
    Parse CSV bytes/str → list of row dicts with detected columns.

    Returns:
        {
            "rows": [...],
            "detected_columns": [...],
            "row_count": int,
            "header_row_index": int,
            "warnings": [...],
        }
    """
    if isinstance(content, bytes):
        # Try UTF-8 first, then latin-1 (common for Indian bank exports)
        for encoding in ("utf-8-sig", "utf-8", "latin-1"):
            try:
                text = content.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = content.decode("latin-1", errors="replace")
    else:
        text = content

    reader_lines = list(csv.reader(io.StringIO(text.replace("\r\n", "\n").replace("\r", "\n"))))
    if not reader_lines:
        return {"rows": [], "detected_columns": [], "row_count": 0, "header_row_index": 0, "warnings": ["Empty file"]}

    # Find the header row — scan first 20 rows for max financial-keyword score
    best_idx = 0
    best_score = -1.0
    for i, row in enumerate(reader_lines[:20]):
        score = _financial_score(row)
        if score > best_score:
            best_score = score
            best_idx = i

    if best_score < 0.05:
        # No recognizable header — use row 0 as header and warn
        best_idx = 0
        warnings = ["No financial header detected; using first row. Verify column mapping."]
    else:
        warnings = []

    raw_headers = [h.strip() for h in reader_lines[best_idx]]
    # De-duplicate headers
    seen: dict[str, int] = {}
    headers = []
    for h in raw_headers:
        if h in seen:
            seen[h] += 1
            headers.append(f"{h}_{seen[h]}")
        else:
            seen[h] = 0
            headers.append(h)

    rows = []
    for row_num, row in enumerate(reader_lines[best_idx + 1:], start=best_idx + 2):
        if not any(c.strip() for c in row):
            continue  # skip blank rows
        obj = {headers[i]: (row[i].strip() if i < len(row) else "") for i in range(len(headers))}
        obj["_row_number"] = row_num
        rows.append(obj)

    return {
        "rows": rows,
        "detected_columns": headers,
        "row_count": len(rows),
        "header_row_index": best_idx,
        "warnings": warnings,
    }
