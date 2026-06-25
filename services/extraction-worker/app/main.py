"""FinVerify OS — Python Extraction Worker (FastAPI)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio

from .config import PYTHON_WORKER_PORT, GEMINI_MODEL, gemini_key
from .routes.parse import router as parse_router
from .routes.extract import router as extract_router
from .routes.extract_expense import router as expense_router
from .routes.tally import router as tally_router

app = FastAPI(
    title="FinVerify Extraction Worker",
    description="CSV/Excel/PDF parsing, normalization, and AI extraction for FinVerify OS.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(parse_router)
app.include_router(extract_router)
app.include_router(expense_router)
app.include_router(tally_router)


@app.on_event("startup")
async def warmup():
    """Pre-import heavy dependencies so first user request is fast."""
    import asyncio
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _warmup_imports)


def _warmup_imports():
    try:
        import pandas  # noqa
        import pdfplumber  # noqa
        import openpyxl  # noqa
        import pypdf  # noqa
        print("[warmup] pandas, pdfplumber, openpyxl, pypdf — ready")
    except Exception as e:
        print(f"[warmup] partial: {e}")


@app.get("/health")
async def health():
    """Health check — shows configured AI providers."""
    return {
        "ok": True,
        "service": "finverify-extraction-worker",
        "version": "0.1.0",
        "ai": {
            "gemini": "configured" if gemini_key() else "missing",
            "model": GEMINI_MODEL,
        },
        "capabilities": [
            "parse/csv",
            "parse/excel",
            "parse/pdf-text",
            "parse/pdf-table",
            "parse/tally",
            "extract/bank-statement",
            "extract/tally-ledger",
            "extract/gateway-statement",
            "extract/invoice",
            "extract/gst-tds",
            "extract/payroll",
            "extract/expense",
        ],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PYTHON_WORKER_PORT)
