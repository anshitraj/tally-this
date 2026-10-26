"""Who may call the worker.

The worker is an internal service. Only the TallyThis API (and the gateway's health check) talk to it,
never a browser. Every request except /health must carry the shared service token. In production the
worker refuses to serve without a strong token, so a missing variable closes the worker instead of
leaving it open to anyone who can reach it.

On a developer machine the token is optional so that `uvicorn app.main:app` keeps working as before.
"""
from __future__ import annotations

import hmac
import os
from collections.abc import Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

SERVICE_TOKEN_HEADER = "x-service-token"
# Railway's health check cannot send a token, and /health reveals nothing but which AI keys exist.
PUBLIC_PATHS = frozenset({"/health"})
MIN_TOKEN_LENGTH = 24


def is_production(env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return any(env.get(key, "").strip().lower() == "production" for key in ("APP_ENV", "NODE_ENV"))


def service_token(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return env.get("WORKER_SERVICE_TOKEN", "").strip()


def configuration_problem(env: Mapping[str, str] | None = None) -> str | None:
    """Why this worker must not serve requests, or None when it may."""
    env = os.environ if env is None else env
    if not is_production(env):
        return None
    token = service_token(env)
    if not token:
        return "WORKER_SERVICE_TOKEN is not set"
    if len(token) < MIN_TOKEN_LENGTH:
        return f"WORKER_SERVICE_TOKEN is too short (use at least {MIN_TOKEN_LENGTH} random characters)"
    return None


def install_service_auth(app: FastAPI) -> None:
    """Requires the service token on every route except /health."""

    @app.middleware("http")
    async def require_service_token(request: Request, call_next):
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        if configuration_problem() is not None:
            # Fail closed. The reason is in the startup log, not in the reply.
            return JSONResponse({"detail": "The worker is not configured to accept requests."}, status_code=503)

        expected = service_token()
        if expected:
            provided = request.headers.get(SERVICE_TOKEN_HEADER, "")
            if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
                return JSONResponse({"detail": "Service authentication required."}, status_code=401)
        return await call_next(request)
