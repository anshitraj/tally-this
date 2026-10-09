"""Tally HTTP Gateway connector.

Tally Prime / ERP 9 can act as an HTTP server (Gateway of Tally → F1: Help →
Settings → Connectivity, "Tally.NET / act as server", default port 9000). It
accepts an XML "Export Data" request and returns the report XML.

This connector builds that request, POSTs it to the user's running Tally, and
parses the response with the existing Tally XML parser — the "no manual export"
path. Tally must be reachable from the worker host (typically same LAN).
"""
from __future__ import annotations

import httpx

from ..parsers.tally_xml import parse_tally_xml


def _tally_date(iso: str) -> str:
    """ISO yyyy-mm-dd -> Tally YYYYMMDD. Pass through if already 8 digits."""
    s = (iso or "").strip()
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return s.replace("-", "")
    return s


def build_export_request(company: str, from_date: str, to_date: str, report: str = "Day Book") -> str:
    """Build a Tally 'Export Data' request envelope for the given report and period."""
    return (
        "<ENVELOPE>"
        "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
        "<BODY><EXPORTDATA><REQUESTDESC>"
        f"<REPORTNAME>{report}</REPORTNAME>"
        "<STATICVARIABLES>"
        "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
        f"<SVFROMDATE>{_tally_date(from_date)}</SVFROMDATE>"
        f"<SVTODATE>{_tally_date(to_date)}</SVTODATE>"
        f"<SVCURRENTCOMPANY>{company}</SVCURRENTCOMPANY>"
        "</STATICVARIABLES>"
        "</REQUESTDESC></EXPORTDATA></BODY>"
        "</ENVELOPE>"
    )


async def fetch_from_tally(host: str, port: int, company: str, from_date: str, to_date: str, report: str = "Day Book") -> dict:
    """POST an export request to a live Tally gateway and parse the response.

    Returns the normalized parse_tally_xml dict on success, or
    {ok: False, errors: [...]} with a clear message when Tally is unreachable.
    """
    url = f"http://{host}:{port}"
    request_xml = build_export_request(company, from_date, to_date, report)
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, content=request_xml.encode("utf-8"), headers={"Content-Type": "text/xml"})
    except httpx.ConnectError:
        return {"ok": False, "errors": [f"Could not connect to Tally at {url}. Open Tally, load the company, and enable 'act as server' (port {port})."], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}
    except httpx.TimeoutException:
        return {"ok": False, "errors": [f"Tally at {url} did not respond in time."], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}
    except Exception as e:  # noqa: BLE001 — surface any transport error cleanly
        return {"ok": False, "errors": [f"Tally request failed: {e}"], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}

    if resp.status_code != 200:
        return {"ok": False, "errors": [f"Tally returned HTTP {resp.status_code}."], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}

    body = resp.content or b""
    # Tally responds with an error envelope (LINEERROR) when the company/report is wrong.
    text_head = body[:2000].decode("utf-8", errors="replace").lower()
    if "lineerror" in text_head and "<voucher" not in text_head and "<ledger" not in text_head:
        return {"ok": False, "errors": [f"Tally rejected the request — check the company name '{company}' and that the report exists."], "ledgers": [], "vouchers": [], "voucher_lines": [], "fixed_assets": []}

    result = parse_tally_xml(body)
    result["report"] = report
    result["company"] = company
    return result
