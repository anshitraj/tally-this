"""Tally HTTP Gateway connector.

Tally Prime / ERP 9 can act as an HTTP server (Gateway of Tally → F1: Help →
Settings → Connectivity, "Tally.NET / act as server", default port 9000). It
accepts an XML "Export Data" request and returns the report XML.

This connector builds that request, POSTs it to the user's running Tally, and
parses the response with the existing Tally XML parser — the "no manual export"
path. Tally must be reachable from the worker host (typically the same computer).

The destination is never taken on trust: see ``tally_target`` for the allow-list and
the production default (off). Nothing here has been run against a real TallyPrime.
"""
from __future__ import annotations

import asyncio
import re
from xml.sax.saxutils import escape

import httpx

from ..parsers.tally_xml import parse_tally_xml
from .tally_target import TallyTargetError, validate_target

_REPORT = re.compile(r"^[A-Za-z0-9 &'().,_-]{1,60}$")
_DIGITS = re.compile(r"^\d{8}$")


def _tally_date(iso: str) -> str:
    """ISO yyyy-mm-dd -> Tally YYYYMMDD. Pass through if already 8 digits."""
    s = (iso or "").strip()
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return s.replace("-", "")
    return s


def _checked_date(value: str) -> str:
    converted = _tally_date(value)
    if converted and not _DIGITS.match(converted):
        raise TallyTargetError("Dates must be written as YYYY-MM-DD.")
    return converted


def build_export_request(company: str, from_date: str, to_date: str, report: str = "Day Book") -> str:
    """Build a Tally 'Export Data' request envelope for the given report and period.

    Everything placed in the XML is checked or escaped, so a company name cannot add its own tags.
    """
    company = (company or "").strip()
    if not company or len(company) > 200 or any(ord(ch) < 32 for ch in company):
        raise TallyTargetError("Enter the Tally company name exactly as it appears in Tally.")
    if not _REPORT.match(report or ""):
        raise TallyTargetError("That report name is not allowed.")
    return (
        "<ENVELOPE>"
        "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
        "<BODY><EXPORTDATA><REQUESTDESC>"
        f"<REPORTNAME>{escape(report)}</REPORTNAME>"
        "<STATICVARIABLES>"
        "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
        f"<SVFROMDATE>{escape(_checked_date(from_date))}</SVFROMDATE>"
        f"<SVTODATE>{escape(_checked_date(to_date))}</SVTODATE>"
        f"<SVCURRENTCOMPANY>{escape(company)}</SVCURRENTCOMPANY>"
        "</STATICVARIABLES>"
        "</REQUESTDESC></EXPORTDATA></BODY>"
        "</ENVELOPE>"
    )


def _failure(message: str, *, blocked: bool = False) -> dict:
    return {
        "ok": False,
        "blocked": blocked,
        "errors": [message],
        "ledgers": [],
        "vouchers": [],
        "voucher_lines": [],
        "fixed_assets": [],
    }


async def fetch_from_tally(
    host: str,
    port: int,
    company: str,
    from_date: str,
    to_date: str,
    report: str = "Day Book",
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """POST an export request to a live Tally gateway and parse the response.

    Returns the normalized parse_tally_xml dict on success, or
    {ok: False, errors: [...]} with a clear message when Tally is unreachable or the
    destination is not allowed (``blocked`` is then True).
    """
    try:
        # Resolving a name can block, so it runs off the event loop.
        target = await asyncio.get_running_loop().run_in_executor(None, lambda: validate_target(host, port))
        request_xml = build_export_request(company, from_date, to_date, report)
    except TallyTargetError as exc:
        return _failure(str(exc), blocked=True)

    shown = f"{target.host}:{target.port}"
    try:
        # The connection goes to the address that was checked. Redirects and proxy settings are off, so a
        # reply cannot send the worker somewhere else.
        async with httpx.AsyncClient(timeout=60, follow_redirects=False, trust_env=False, transport=transport) as client:
            resp = await client.post(target.url, content=request_xml.encode("utf-8"), headers={"Content-Type": "text/xml"})
    except httpx.ConnectError:
        return _failure(f"Could not connect to Tally at {shown}. Open Tally, load the company, and enable 'act as server' (port {target.port}).")
    except httpx.TimeoutException:
        return _failure(f"Tally at {shown} did not respond in time.")
    except Exception as e:  # noqa: BLE001 — surface any transport error cleanly
        return _failure(f"Tally request failed: {e}")

    if resp.status_code != 200:
        return _failure(f"Tally returned HTTP {resp.status_code}.")

    body = resp.content or b""
    # Tally responds with an error envelope (LINEERROR) when the company/report is wrong.
    text_head = body[:2000].decode("utf-8", errors="replace").lower()
    if "lineerror" in text_head and "<voucher" not in text_head and "<ledger" not in text_head:
        return _failure(f"Tally rejected the request — check the company name '{company}' and that the report exists.")

    result = parse_tally_xml(body)
    result["report"] = report
    result["company"] = company
    return result
