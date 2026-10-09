import os
from dotenv import load_dotenv

# Load from repo root .env if present
_env_paths = [
    os.path.join(os.path.dirname(__file__), "../../..", ".env"),
    os.path.join(os.path.dirname(__file__), "../.env"),
]
for _p in _env_paths:
    if os.path.exists(_p):
        load_dotenv(_p)
        break

GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
GENAI_API_KEY: str = os.getenv("GENAI_API_KEY", "")
GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
PYTHON_WORKER_PORT: int = int(os.getenv("PYTHON_WORKER_PORT", "8091"))
MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "50"))
PDF_AI_FALLBACK: bool = os.getenv("PDF_AI_FALLBACK", "true").lower() != "false"

def gemini_key() -> str:
    return GEMINI_API_KEY or GENAI_API_KEY
