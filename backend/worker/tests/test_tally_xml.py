"""The Tally XML export reader behind the Tax Audit import (POST /parse/tally)."""
from pathlib import Path

import pytest

from app.parsers.tally_xml import _canonical_vch_type, _num, parse_tally_xml

SAMPLE = Path(__file__).with_name("sample_tally.xml")


def envelope(*messages: str) -> bytes:
    body = "".join(f"<TALLYMESSAGE>{m}</TALLYMESSAGE>" for m in messages)
    return f"<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>{body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>".encode()


def ledger(name: str, group: str, opening: str = "0", closing: str | None = None, extra: str = "") -> str:
    closing_xml = f"<CLOSINGBALANCE>{closing}</CLOSINGBALANCE>" if closing is not None else ""
    return f'<LEDGER NAME="{name}"><PARENT>{group}</PARENT><OPENINGBALANCE>{opening}</OPENINGBALANCE>{closing_xml}{extra}</LEDGER>'


def entry(name: str, amount: str, deemed_positive: str = "") -> str:
    deemed = f"<ISDEEMEDPOSITIVE>{deemed_positive}</ISDEEMEDPOSITIVE>" if deemed_positive else ""
    return f"<ALLLEDGERENTRIES.LIST><LEDGERNAME>{name}</LEDGERNAME>{deemed}<AMOUNT>{amount}</AMOUNT></ALLLEDGERENTRIES.LIST>"


def voucher(kind: str, number: str, date: str, party: str, *entries: str, narration: str = "") -> str:
    narration_xml = f"<NARRATION>{narration}</NARRATION>" if narration else ""
    return (f'<VOUCHER VCHTYPE="{kind}"><DATE>{date}</DATE><VOUCHERTYPENAME>{kind}</VOUCHERTYPENAME>'
            f"<VOUCHERNUMBER>{number}</VOUCHERNUMBER><PARTYLEDGERNAME>{party}</PARTYLEDGERNAME>{narration_xml}{''.join(entries)}</VOUCHER>")


MASTERS = (
    ledger("Cash", "Cash-in-Hand", "50000", "20000"),
    ledger("HDFC Bank", "Bank Accounts", "100000", "90000"),
    ledger("Vendor A", "Sundry Creditors", "-100000", "-90000"),
    ledger("Customer A", "Sundry Debtors", "40000", "60000"),
)


# ── amounts ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("1,23,456.50", 123456.5),
    ("-500", -500.0),
    ("(-)500.00", -500.0),
    ("₹ 1,000.00", 1000.0),
    ("", 0.0),
    ("-", 0.0),
    ("abc", 0.0),
])
def test_amounts_are_read_the_way_tally_writes_them(raw, expected):
    assert _num(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("Payment", "Payment"), ("Pymt", "Payment"), ("Rcpt", "Receipt"), ("Receipt Note", "Receipt"), ("Jrnl", "Journal"),
    ("Sales", "Sales"), ("Purchase", "Purchase"), ("Debit Note", "Debit Note"), ("Credit Note", "Credit Note"),
    ("Contra", "Contra"), ("Memo", "Journal"),
])
def test_voucher_types_are_named_the_way_the_engine_expects(raw, expected):
    assert _canonical_vch_type(raw) == expected


# ── masters ─────────────────────────────────────────────────────────────────

def test_ledger_masters_keep_group_and_signed_balances_and_msme_and_pan():
    xml = envelope(
        ledger("Vendor A", "Sundry Creditors", "-100000.00", "-90000.00", "<MSMEREGISTRATIONTYPE>Micro</MSMEREGISTRATIONTYPE><INCOMETAXNUMBER>ABCDE1234F</INCOMETAXNUMBER>"),
        ledger("Customer A", "Sundry Debtors", "40000", "60000"),
    )
    parsed = parse_tally_xml(xml)
    assert parsed["ok"] is True
    vendor, customer = parsed["ledgers"]
    assert (vendor["name"], vendor["group"], vendor["opening_balance"], vendor["closing_balance"]) == ("Vendor A", "Sundry Creditors", -100000.0, -90000.0)
    assert (vendor["is_msme"], vendor["msme_type"], vendor["pan"]) == (True, "Micro", "ABCDE1234F")
    assert (customer["is_msme"], customer["msme_type"], customer["pan"]) == (False, None, None)
    # What a single-year export cannot carry is left empty, never made up.
    assert vendor["prev_year_closing"] is None and vendor["prev_year_group"] is None


# ── vouchers ────────────────────────────────────────────────────────────────

def test_a_cash_payment_has_its_debit_and_credit_sides_its_amount_and_its_mode():
    xml = envelope(*MASTERS, voucher("Payment", "P-1", "20250809", "Vendor A", entry("Vendor A", "-18000.00", "Yes"), entry("Cash", "18000.00", "No"), narration="Freight paid cash"))
    parsed = parse_tally_xml(xml)
    (v,) = parsed["vouchers"]
    assert (v["date"], v["type"], v["number"], v["party"], v["narration"], v["amount"], v["mode"]) == ("2025-08-09", "Payment", "P-1", "Vendor A", "Freight paid cash", 18000.0, "Cash")
    assert parsed["voucher_lines"] == [
        {"voucher_number": "P-1", "ledger": "Vendor A", "group": "Sundry Creditors", "debit": 18000.0, "credit": 0.0},
        {"voucher_number": "P-1", "ledger": "Cash", "group": "Cash-in-Hand", "debit": 0.0, "credit": 18000.0},
    ]


def test_mode_comes_from_the_ledger_groups_on_the_voucher_and_a_journal_is_a_journal():
    xml = envelope(
        *MASTERS,
        voucher("Payment", "P-1", "20250801", "Vendor A", entry("Vendor A", "-500", "Yes"), entry("HDFC Bank", "500")),
        voucher("Journal", "J-1", "20250802", "Customer A", entry("Customer A", "-100", "Yes"), entry("Vendor A", "100")),
        voucher("Receipt", "R-1", "20250803", "Customer A", entry("Cash", "-300", "Yes"), entry("Customer A", "300")),
    )
    modes = {v["number"]: v["mode"] for v in parse_tally_xml(xml)["vouchers"]}
    assert modes == {"P-1": "Bank", "J-1": "Journal", "R-1": "Cash"}


def test_the_amount_of_a_voucher_is_its_largest_line_so_tax_lines_do_not_double_it():
    xml = envelope(*MASTERS, voucher("Sales", "S-1", "20250801", "Customer A",
                                     entry("Customer A", "-118.00", "Yes"), entry("Sales", "100.00"), entry("Output GST", "18.00")))
    (v,) = parse_tally_xml(xml)["vouchers"]
    assert v["amount"] == 118.0


def test_a_voucher_without_a_number_gets_one_and_the_lines_follow_it():
    xml = envelope(*MASTERS, voucher("Payment", "", "20250801", "Vendor A", entry("Vendor A", "-5"), entry("Cash", "5")))
    parsed = parse_tally_xml(xml)
    assert parsed["vouchers"][0]["number"] == "AUTO-1"
    assert {line["voucher_number"] for line in parsed["voucher_lines"]} == {"AUTO-1"}


def test_two_voucher_types_numbered_alike_never_share_a_number_or_their_lines():
    # Tally numbers each voucher type on its own, so a Receipt 1 and a Payment 1 are two different vouchers.
    xml = envelope(
        *MASTERS,
        voucher("Receipt", "1", "20250801", "Customer A", entry("Cash", "-300", "Yes"), entry("Customer A", "300")),
        voucher("Payment", "1", "20250802", "Vendor A", entry("Vendor A", "-500", "Yes"), entry("Cash", "500")),
        voucher("Sales", "2", "20250803", "Customer A", entry("Customer A", "-100", "Yes"), entry("Sales", "100")),
    )
    parsed = parse_tally_xml(xml)
    numbers = [v["number"] for v in parsed["vouchers"]]
    assert numbers == ["Receipt 1", "Payment 1", "2"]
    by_number: dict[str, list[str]] = {}
    for line in parsed["voucher_lines"]:
        by_number.setdefault(line["voucher_number"], []).append(line["ledger"])
    assert by_number == {"Receipt 1": ["Cash", "Customer A"], "Payment 1": ["Vendor A", "Cash"], "2": ["Customer A", "Sales"]}


def test_the_same_type_and_number_twice_still_gets_two_different_numbers():
    xml = envelope(
        *MASTERS,
        voucher("Payment", "7", "20250801", "Vendor A", entry("Vendor A", "-5"), entry("Cash", "5")),
        voucher("Payment", "7", "20250901", "Vendor A", entry("Vendor A", "-6"), entry("Cash", "6")),
        voucher("Payment", "7", "20250901", "Vendor A", entry("Vendor A", "-7"), entry("Cash", "7")),
    )
    numbers = [v["number"] for v in parse_tally_xml(xml)["vouchers"]]
    assert len(set(numbers)) == 3
    assert numbers[0] == "Payment 7"


# ── bills ───────────────────────────────────────────────────────────────────

def test_bill_allocations_become_new_agst_and_advance_references():
    bills = (
        "<BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-1000</AMOUNT></BILLALLOCATIONS.LIST>"
        "<BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>400</AMOUNT></BILLALLOCATIONS.LIST>"
        "<BILLALLOCATIONS.LIST><NAME>ADV-9</NAME><BILLTYPE>Advance</BILLTYPE><AMOUNT>250</AMOUNT></BILLALLOCATIONS.LIST>"
    )
    xml = envelope(*MASTERS, voucher("Journal", "J-1", "20250801", "Customer A",
                                     "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>-1000</AMOUNT>" + bills + "</ALLLEDGERENTRIES.LIST>"))
    parsed = parse_tally_xml(xml)
    assert [(b["party"], b["ref"], b["type"], b["amount"], b["date"]) for b in parsed["bills"]] == [
        ("Customer A", "INV-1", "New Ref", 1000.0, "2025-08-01"),
        ("Customer A", "INV-1", "Agst Ref", 400.0, "2025-08-01"),
        ("Customer A", "ADV-9", "Advance", 250.0, "2025-08-01"),
    ]


# ── what a file lacks is said ───────────────────────────────────────────────

def test_a_day_book_without_ledger_masters_says_so():
    parsed = parse_tally_xml(envelope(voucher("Payment", "P-1", "20250801", "Vendor A", entry("Vendor A", "-5"), entry("Cash", "5"))))
    assert parsed["ok"] is True and parsed["ledgers"] == []
    assert any("no ledger masters" in w for w in parsed["warnings"])
    # Without groups the lines carry none, and the mode cannot be told.
    assert {line["group"] for line in parsed["voucher_lines"]} == {""}
    assert parsed["vouchers"][0]["mode"] is None


def test_masters_without_closing_balances_say_so_and_do_not_pretend_otherwise():
    parsed = parse_tally_xml(envelope(ledger("Vendor A", "Sundry Creditors", "-100"), ledger("Customer A", "Sundry Debtors", "40")))
    assert any("no closing balances" in w for w in parsed["warnings"])
    assert any("no vouchers" in w for w in parsed["warnings"])
    # The balance the file did give is not lost; the engine decides what the lack means.
    assert [l["closing_balance"] for l in parsed["ledgers"]] == [-100.0, 40.0]


def test_a_complete_export_has_no_warnings():
    xml = envelope(*MASTERS, voucher("Payment", "P-1", "20250801", "Vendor A", entry("Vendor A", "-5"), entry("Cash", "5")))
    assert parse_tally_xml(xml)["warnings"] == []


def test_a_file_that_is_not_xml_or_not_tally_is_not_ok():
    broken = parse_tally_xml(b"<ENVELOPE><BODY>")
    assert broken["ok"] is False and broken["errors"] and broken["ledgers"] == [] and broken["vouchers"] == []
    other = parse_tally_xml(b"<html><body>hello</body></html>")
    assert other["ok"] is False and any("Tally XML" in w for w in other["warnings"])
    assert parse_tally_xml(b"")["ok"] is False


# ── the sample that ships with the tests ────────────────────────────────────

def test_the_sample_export_reads_completely():
    parsed = parse_tally_xml(SAMPLE.read_bytes())
    assert parsed["ok"] is True
    assert parsed["counts"] == {"ledgers": len(parsed["ledgers"]), "vouchers": len(parsed["vouchers"]), "voucher_lines": len(parsed["voucher_lines"]), "bills": len(parsed["bills"])}
    assert parsed["counts"]["ledgers"] >= 5 and parsed["counts"]["vouchers"] >= 3
    # Every voucher's lines balance: what is debited is credited.
    totals: dict[str, float] = {}
    for line in parsed["voucher_lines"]:
        totals[line["voucher_number"]] = round(totals.get(line["voucher_number"], 0.0) + line["debit"] - line["credit"], 2)
    assert all(abs(balance) < 0.01 for balance in totals.values()), totals
    assert len({v["number"] for v in parsed["vouchers"]}) == len(parsed["vouchers"])
