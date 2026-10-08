"""FastAPI Tally route — POST /parse/tally.

Accepts a Tally XML export and returns normalized ledgers + vouchers + lines
for the FinVerify Tax Audit engine.
"""
from fastapi import APIRouter, File, UploadFile, Form, HTTPException

from ..parsers.tally_xml import parse_tally_xml

router = APIRouter(prefix="/parse", tags=["parse"])


@router.post("/tally")
async def parse_tally_upload(
    file: UploadFile = File(...),
    company_id: int | None = Form(None),
):
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty file")
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 50MB)")

    result = parse_tally_xml(content)
    result["company_id"] = company_id
    result["file_name"] = file.filename
    return result
