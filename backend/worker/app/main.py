"""TallyThis — Python Extraction Worker (FastAPI)."""
from fastapi import APIRouter, FastAPI

from .config import PYTHON_WORKER_PORT, GEMINI_MODEL, gemini_key
from .security import configuration_problem, install_service_auth, is_production, service_token
from .routes.parse import router as parse_router
from .routes.extract import router as extract_router
from .routes.extract_expense import router as expense_router
from .routes.tally import router as tally_router
from .routes.connector import router as connector_router

health_router = APIRouter()


@health_router.get("/health")
async def health():
    """Health check — shows configured AI providers. The only route that needs no service token."""
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
            "connector/tally-fetch",
            "extract/bank-statement",
            "extract/tally-ledger",
            "extract/gateway-statement",
            "extract/invoice",
            "extract/gst-tds",
            "extract/payroll",
            "extract/marketplace",
            "extract/expense",
        ],
    }


async def check_security():
    problem = configuration_problem()
    if problem:
        print(f"[security] REFUSING REQUESTS: {problem}. Set it on this service and on the API.")
    elif not service_token():
        print("[security] WORKER_SERVICE_TOKEN is not set: any caller that can reach this worker is accepted. "
              "Fine on a developer machine; never in production.")


def _warmup_imports():
    try:
        import pandas  # noqa
        import pdfplumber  # noqa
        import openpyxl  # noqa
        import pypdf  # noqa
        print("[warmup] pandas, pdfplumber, openpyxl, pypdf — ready")
    except Exception as e:
        print(f"[warmup] partial: {e}")


async def warmup():
    """Pre-import heavy dependencies so first user request is fast."""
    import asyncio
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _warmup_imports)


def create_app() -> FastAPI:
    """Builds the worker. A function so tests can build it under different environments."""
    production = is_production()
    application = FastAPI(
        title="TallyThis Extraction Worker",
        description="CSV/Excel/PDF parsing, normalization, and AI extraction for TallyThis.",
        version="0.1.0",
        # The interactive docs list every route; they are for developers only.
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    # An internal service: no browser ever calls it, so there is no CORS setting. Every route except
    # /health needs the shared service token (app/security.py).
    install_service_auth(application)

    application.include_router(health_router)
    application.include_router(parse_router)
    application.include_router(extract_router)
    application.include_router(expense_router)
    application.include_router(tally_router)
    application.include_router(connector_router)
    application.add_event_handler("startup", check_security)
    application.add_event_handler("startup", warmup)
    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PYTHON_WORKER_PORT)
