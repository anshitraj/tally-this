"""Gemini Vision extraction for image-based (scanned) PDFs and images."""
import base64
import json
import re
import io
import httpx
from ..config import gemini_key, GEMINI_MODEL


VISION_BANK_PROMPT = """You are a financial data extraction engine.
Extract ALL bank transactions from this bank statement image/page.
Return ONLY a JSON array. Each element:
{
  "date": "YYYY-MM-DD or original format",
  "description": "narration text",
  "reference": "UTR/cheque/reference number or null",
  "debit": number or null,
  "credit": number or null,
  "balance": number or null
}
Skip header rows, summary rows, opening/closing balance rows.
Amounts as plain numbers (no commas, no currency symbols).
Return [] if no transactions visible.
JSON:"""

VISION_INVOICE_PROMPT = """Extract invoice fields from this invoice image.
Return ONLY a JSON object:
{
  "invoice_number": string or null,
  "invoice_date": "YYYY-MM-DD" or null,
  "vendor_name": string or null,
  "vendor_gstin": string or null,
  "customer_name": string or null,
  "customer_gstin": string or null,
  "subtotal": number or null,
  "gst_amount": number or null,
  "total_amount": number or null,
  "confidence": 0.0-1.0,
  "warnings": ["AI extracted — pending review"]
}
Never invent values. null for uncertain fields.
JSON:"""


async def vision_extract_bank(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """Extract bank transactions from an image using Gemini Vision."""
    key = gemini_key()
    if not key:
        return {"ok": False, "rows": [], "errors": ["GEMINI_API_KEY not set"]}

    b64 = base64.b64encode(image_bytes).decode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={key}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json={
                "contents": [{"role": "user", "parts": [
                    {"inlineData": {"mimeType": mime_type, "data": b64}},
                    {"text": VISION_BANK_PROMPT},
                ]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 4096},
            })
        if resp.status_code != 200:
            return {"ok": False, "rows": [], "errors": [f"Gemini HTTP {resp.status_code}"]}

        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"```\s*$", "", raw).strip()

        rows = json.loads(raw)
        if not isinstance(rows, list):
            rows = []
        return {
            "ok": bool(rows),
            "rows": rows,
            "extraction_method": "vision_ai",
            "confidence": 0.7,
            "warnings": ["AI extracted via Gemini Vision — pending CA review"],
            "errors": [] if rows else ["Gemini Vision returned no transactions"],
        }
    except Exception as e:
        return {"ok": False, "rows": [], "errors": [str(e)]}


async def vision_extract_invoice(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    """Extract invoice fields from an image using Gemini Vision."""
    key = gemini_key()
    if not key:
        return {"ok": False, "invoice": None, "errors": ["GEMINI_API_KEY not set"]}

    b64 = base64.b64encode(image_bytes).decode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={key}"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json={
                "contents": [{"role": "user", "parts": [
                    {"inlineData": {"mimeType": mime_type, "data": b64}},
                    {"text": VISION_INVOICE_PROMPT},
                ]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 2048},
            })
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"```\s*$", "", raw).strip()
        invoice = json.loads(raw)
        return {
            "ok": True,
            "invoice": invoice,
            "extraction_method": "vision_ai",
            "confidence": float(invoice.get("confidence", 0.65)),
            "warnings": ["AI extracted via Gemini Vision — pending review"],
            "errors": [],
        }
    except Exception as e:
        return {"ok": False, "invoice": None, "errors": [str(e)]}


async def pdf_page_to_image_bytes(pdf_bytes: bytes, page_num: int = 0) -> tuple[bytes, str]:
    """Convert a PDF page to JPEG bytes for Vision API. Requires pillow + pypdf."""
    try:
        from pypdf import PdfReader
        import PIL.Image
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if page_num >= len(reader.pages):
            return b"", ""
        # pypdf can extract images; for rendering we use pixmap approach via pillow
        # For now, return raw PDF page bytes with application/pdf mime
        page_bytes = io.BytesIO()
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_page(reader.pages[page_num])
        writer.write(page_bytes)
        return page_bytes.getvalue(), "application/pdf"
    except Exception:
        return b"", ""
