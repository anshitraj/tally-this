"""The worker only answers callers that hold the service token (production fails closed)."""
import pytest
from fastapi.testclient import TestClient

from app.main import create_app

STRONG = "a-long-random-service-token-0123456789"


@pytest.fixture
def clean_env(monkeypatch):
    for key in ("APP_ENV", "NODE_ENV", "WORKER_SERVICE_TOKEN", "TALLY_CONNECTOR_ENABLED", "TALLY_ALLOWED_HOSTS", "TALLY_ALLOWED_PORTS"):
        monkeypatch.delenv(key, raising=False)
    return monkeypatch


def client(monkeypatch=None) -> TestClient:
    # Built after the environment is set, the way a real process starts.
    return TestClient(create_app())


def production(monkeypatch, token: str | None = STRONG):
    monkeypatch.setenv("APP_ENV", "production")
    if token is not None:
        monkeypatch.setenv("WORKER_SERVICE_TOKEN", token)


# A route that does real work and answers 400 for an empty body, so reaching it proves the token was accepted.
def reach(c: TestClient, headers: dict | None = None):
    return c.post("/parse/tally", files={"file": ("empty.xml", b"")}, headers=headers or {})


def test_production_without_a_token_refuses_everything_except_health(clean_env):
    production(clean_env, token=None)
    c = client()
    assert c.get("/health").status_code == 200
    assert reach(c).status_code == 503
    assert reach(c, {"X-Service-Token": "anything"}).status_code == 503


def test_production_with_a_short_token_refuses_everything_except_health(clean_env):
    production(clean_env, token="short")
    c = client()
    assert c.get("/health").status_code == 200
    assert reach(c, {"X-Service-Token": "short"}).status_code == 503


def test_production_needs_the_exact_token(clean_env):
    production(clean_env)
    c = client()
    assert reach(c).status_code == 401
    assert reach(c, {"X-Service-Token": ""}).status_code == 401
    assert reach(c, {"X-Service-Token": STRONG[:-1]}).status_code == 401
    assert reach(c, {"X-Service-Token": STRONG + "x"}).status_code == 401
    assert reach(c, {"X-Service-Token": STRONG.upper()}).status_code == 401
    assert reach(c, {"X-Service-Token": STRONG}).status_code == 400  # past the check, the route rejects the empty file


def test_every_route_except_health_is_behind_the_token(clean_env):
    production(clean_env)
    c = client()
    paths = sorted({route.path for route in c.app.routes if hasattr(route, "methods") and route.path != "/health"})
    assert len(paths) >= 10, "the route list looks wrong"
    for path in paths:
        for method in ("GET", "POST"):
            response = c.request(method, path)
            assert response.status_code in (401, 404), f"{method} {path} answered {response.status_code} without a token"


def test_a_developer_machine_without_a_token_still_works(clean_env):
    c = client()
    assert c.get("/health").status_code == 200
    assert reach(c).status_code == 400


def test_a_token_set_on_a_developer_machine_is_enforced(clean_env):
    clean_env.setenv("WORKER_SERVICE_TOKEN", "dev-token")
    c = client()
    assert reach(c).status_code == 401
    assert reach(c, {"X-Service-Token": "dev-token"}).status_code == 400


def test_nodes_env_name_also_means_production(clean_env):
    clean_env.setenv("NODE_ENV", "production")
    assert reach(client()).status_code == 503


def test_there_is_no_open_cors(clean_env):
    production(clean_env)
    c = client()
    for response in (
        c.get("/health", headers={"Origin": "https://evil.example.com"}),
        c.options("/parse/tally", headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"}),
    ):
        assert "access-control-allow-origin" not in {k.lower() for k in response.headers}


def test_production_hides_the_api_documentation(clean_env):
    production(clean_env)
    c = client()
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path, headers={"X-Service-Token": STRONG}).status_code == 404


def test_development_keeps_the_documentation(clean_env):
    assert client().get("/openapi.json").status_code == 200


def test_the_tally_connector_refuses_a_caller_chosen_host_over_http(clean_env):
    production(clean_env)
    clean_env.setenv("TALLY_CONNECTOR_ENABLED", "true")
    c = client()
    body = {"host": "169.254.169.254", "port": 9000, "company": "ACME", "from_date": "2026-04-01", "to_date": "2026-04-30"}
    response = c.post("/connector/tally-fetch", json=body, headers={"X-Service-Token": STRONG})
    assert response.status_code == 403
    assert response.json()["ok"] is False
    assert response.json()["blocked"] is True
