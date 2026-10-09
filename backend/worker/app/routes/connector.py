"""FastAPI connector route — POST /connector/tally-fetch.

Pulls a Day Book straight from a running Tally gateway and returns normalized
ledgers + vouchers + lines (same shape as /parse/tally).
"""
from fastapi import APIRouter
from pydantic import BaseModel

from ..connectors.tally_gateway import fetch_from_tally

router = APIRouter(prefix="/connector", tags=["connector"])


class TallyFetchRequest(BaseModel):
    host: str = "localhost"
    port: int = 9000
    company: str
    from_date: str
    to_date: str
    report: str = "Day Book"


@router.post("/tally-fetch")
async def tally_fetch(req: TallyFetchRequest):
    return await fetch_from_tally(req.host, req.port, req.company, req.from_date, req.to_date, req.report)
