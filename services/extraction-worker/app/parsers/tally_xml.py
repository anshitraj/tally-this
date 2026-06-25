"""Tally XML export parser.

Parses a Tally "Export → Day Book / Masters" XML into the normalized shape the
FinVerify Tax Audit engine consumes:

    {
      "ledgers":       [{name, group, opening_balance, closing_balance, prev_year_closing, prev_year_group, is_msme, msme_type, pan}],
      "vouchers":      [{date, type, number, party, narration, amount, mode}],
      "voucher_lines": [{voucher_number, ledger, group, debit, credit}],
      "fixed_assets":  [],   # not present in standard day-book export
    }

Tally sign conventions handled here:
  * Ledger OPENINGBALANCE / CLOSINGBALANCE: debit balances are positive,
    credit balances carry a leading '-'. We keep them signed (+Dr / -Cr),
    matching the engine.
  * Voucher ledger AMOUNT: negative = debit side, positive = credit side
    (Tally stores debit amounts as negative in the XML). ISDEEMEDPOSITIVE=Yes
    also marks the debit side; we use the amount sign as the primary signal.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any

# Cash / bank ledger group hints, used to infer voucher "mode".
_CASH_HINTS = ("cash-in-hand", "cash in hand", "cash")
_BANK_HINTS = ("bank accounts", "bank account", "bank od", "bank occ")


def _text(el: ET.Element | None) -> str:
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def _num(raw: str) -> float:
    """Parse a Tally amount/balance string to float. Handles '-', commas, '(-)'. """
    if not raw:
        return 0.0
    s = raw.strip().replace(",", "")
    neg = False
    if s.startswith("(-)") or s.startswith("(-"):
        neg = True
        s = s.replace("(-)", "").replace("(-", "").replace(")", "")
    s = re.sub(r"[^0-9.\-]", "", s)
    if s in ("", "-", "."):
        return 0.0
    try:
        val = float(s)
    except ValueError:
        return 0.0
    return -abs(val) if neg else val


def _norm_date(raw: str) -> str:
    """Tally dates are YYYYMMDD → ISO yyyy-mm-dd."""
    s = raw.strip()
    if re.fullmatch(r"\d{8}", s):
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s


def _infer_mode(line_groups: list[str], vch_type: str) -> str | None:
    joined = " ".join(g.lower() for g in line_groups)
    if any(h in joined for h in _CASH_HINTS):
        return "Cash"
    if any(h in joined for h in _BANK_HINTS):
        return "Bank"
    if vch_type.lower() in ("journal", "jrnl"):
        return "Journal"
    return None


def parse_tally_xml(content: bytes) -> dict[str, Any]:
    """Parse Tally XML bytes into normalized dict. Never raises on malformed
    inner nodes — collects warnings instead."""
    warnings: list[str] = []
    try:
        # Tally exports are often latin-1 / windows-1252 with stray bytes.
        text = content.decode("utf-8", errors="replace")
        root = ET.fromstring(text)
    except ET.ParseError as e:
        return {"ok": False, "errors": [f"Invalid XML: {e}"], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}

    # Group lookup from ledger masters, so voucher lines can carry their group.
    ledger_group: dict[str, str] = {}
    ledgers: list[dict[str, Any]] = []

    for led in root.iter("LEDGER"):
        name = (led.get("NAME") or _text(led.find("NAME")) or "").strip()
        if not name:
            continue
        group = _text(led.find("PARENT"))
        opening = _num(_text(led.find("OPENINGBALANCE")))
        closing_raw = _text(led.find("CLOSINGBALANCE"))
        closing = _num(closing_raw) if closing_raw else opening
        msme_type = _text(led.find("MSMEREGISTRATIONTYPE")) or None
        pan = _text(led.find("INCOMETAXNUMBER")) or _text(led.find("PANNUMBER")) or None
        ledger_group[name] = group
        ledgers.append({
            "name": name,
            "group": group,
            "opening_balance": opening,
            "closing_balance": closing,
            "prev_year_closing": None,
            "prev_year_group": None,
            "is_msme": bool(msme_type),
            "msme_type": msme_type,
            "pan": pan,
        })

    vouchers: list[dict[str, Any]] = []
    voucher_lines: list[dict[str, Any]] = []
    auto_no = 0

    for vch in root.iter("VOUCHER"):
        vch_type = (vch.get("VCHTYPE") or _text(vch.find("VOUCHERTYPENAME")) or "Journal").strip()
        date = _norm_date(_text(vch.find("DATE")))
        number = _text(vch.find("VOUCHERNUMBER"))
        if not number:
            auto_no += 1
            number = f"AUTO-{auto_no}"
        party = _text(vch.find("PARTYLEDGERNAME")) or None
        narration = _text(vch.find("NARRATION")) or None

        line_groups: list[str] = []
        max_abs = 0.0
        # Tally puts entries under ALLLEDGERENTRIES.LIST or LEDGERENTRIES.LIST
        entries = list(vch.iter("ALLLEDGERENTRIES.LIST")) + list(vch.iter("LEDGERENTRIES.LIST"))
        for ent in entries:
            lname = _text(ent.find("LEDGERNAME"))
            if not lname:
                continue
            amt = _num(_text(ent.find("AMOUNT")))
            deemed_pos = _text(ent.find("ISDEEMEDPOSITIVE")).lower() == "yes"
            # Debit side: amount negative in Tally, or ISDEEMEDPOSITIVE=Yes.
            is_debit = amt < 0 or deemed_pos
            debit = abs(amt) if is_debit else 0.0
            credit = abs(amt) if not is_debit else 0.0
            grp = ledger_group.get(lname, "")
            line_groups.append(grp)
            voucher_lines.append({
                "voucher_number": number,
                "ledger": lname,
                "group": grp,
                "debit": round(debit, 2),
                "credit": round(credit, 2),
            })
            max_abs = max(max_abs, abs(amt))

        vouchers.append({
            "date": date,
            "type": _canonical_vch_type(vch_type),
            "number": number,
            "party": party,
            "narration": narration,
            "amount": round(max_abs, 2),
            "mode": _infer_mode(line_groups, vch_type),
        })

    if not ledgers and not vouchers:
        warnings.append("No <LEDGER> or <VOUCHER> nodes found — is this a Tally XML export?")

    return {
        "ok": bool(ledgers or vouchers),
        "warnings": warnings,
        "ledgers": ledgers,
        "vouchers": vouchers,
        "voucher_lines": voucher_lines,
        "fixed_assets": [],
        "counts": {"ledgers": len(ledgers), "vouchers": len(vouchers), "voucher_lines": len(voucher_lines)},
    }


_VCH_MAP = {
    "purchase": "Purchase", "purc": "Purchase",
    "sales": "Sales",
    "receipt": "Receipt", "rcpt": "Receipt",
    "payment": "Payment", "pymt": "Payment",
    "journal": "Journal", "jrnl": "Journal",
    "contra": "Contra",
    "debit note": "Debit Note",
    "credit note": "Credit Note",
}


def _canonical_vch_type(raw: str) -> str:
    key = raw.lower().strip()
    for k, v in _VCH_MAP.items():
        if k in key:
            return v
    return "Journal"
