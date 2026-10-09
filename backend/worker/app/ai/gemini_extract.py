"""Gemini AI extraction for invoice PDFs."""
import json
import re
import os
from typing import Any
import httpx
from ..config import gemini_key, GEMINI_MODEL
from ..models.extraction import InvoiceExtraction


INVOICE_SCHEMA_HINT = """
Extract invoice fields and return ONLY a JSON object:
{
  "invoice_number": string or null,
  "invoice_date": "YYYY-MM-DD" or null,
  "vendor_name": string or null,
  "vendor_gstin": string (15-char GSTIN) or null,
  "customer_name": string or null,
  "customer_gstin": string or null,
  "subtotal": number or null,
  "gst_amount": number or null,
  "total_amount": number or null,
  "line_items": [],
  "confidence": 0.0–1.0,
  "missing_fields": ["field1", ...],
  "warnings": ["text..."],
  "source_quotes": ["direct quote from PDF..."]
}

Rules:
- Never invent values.
- null for unclear fields.
- confidence = fraction of fields found.
- Always label AI output as pending_review.
- Never say "Verified by AI".
"""


async def extract_invoice_via_gemini(text: str, file_name: str) -> dict[str, Any]:
    key = gemini_key()
    if not key:
        return {
            "ok": False,
            "extraction_method": "ai_gemini",
            "confidence": 0.0,
            "invoice": None,
            "warnings": [],
            "errors": ["GEMINI_API_KEY not configured. Cannot run AI extraction."],
        }

    prompt = f"{INVOICE_SCHEMA_HINT}\n\nFile: {file_name}\n\nInvoice text:\n\"\"\"\n{text[:15000]}\n\"\"\"\n\nJSON:"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={key}"

    try:
        async with httpx.AsyncClient(timeout=45) as client:
            resp = await client.post(url, json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 2048},
            })
        if resp.status_code != 200:
            raise ValueError(f"Gemini HTTP {resp.status_code}")

        raw = resp.json()
        raw_text = raw["candidates"][0]["content"]["parts"][0]["text"].strip()
        # Strip markdown fences
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.IGNORECASE)
        raw_text = re.sub(r"```\s*$", "", raw_text).strip()

        data = json.loads(raw_text)
        invoice = InvoiceExtraction(
            invoice_number=data.get("invoice_number"),
            invoice_date=data.get("invoice_date"),
            vendor_name=data.get("vendor_name"),
            vendor_gstin=data.get("vendor_gstin"),
            customer_name=data.get("customer_name"),
            customer_gstin=data.get("customer_gstin"),
            subtotal=data.get("subtotal"),
            gst_amount=data.get("gst_amount"),
            total_amount=data.get("total_amount"),
            line_items=data.get("line_items", []),
            confidence=float(data.get("confidence", 0.7)),
            missing_fields=data.get("missing_fields", []),
            warnings=data.get("warnings", ["AI extracted — pending review"]),
            source_quotes=data.get("source_quotes", []),
        )
        return {
            "ok": True,
            "extraction_method": "ai_gemini",
            "confidence": invoice.confidence,
            "invoice": invoice,
            "warnings": ["AI extracted — pending review"],
            "errors": [],
        }

    except json.JSONDecodeError:
        return {
            "ok": False,
            "extraction_method": "ai_gemini",
            "confidence": 0.0,
            "invoice": None,
            "warnings": [],
            "errors": ["AI returned invalid JSON. Try again or use manual extraction."],
        }
    except Exception as e:
        return {
            "ok": False,
            "extraction_method": "ai_gemini",
            "confidence": 0.0,
            "invoice": None,
            "warnings": [],
            "errors": [f"AI extraction failed: {str(e)}"],
        }
