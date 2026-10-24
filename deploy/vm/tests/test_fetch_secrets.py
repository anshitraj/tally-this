"""Runs deploy/vm/fetch-secrets.sh against a fake metadata server and a fake Secret Manager.

Nothing here talks to Google. The script's three addresses can be overridden for exactly this purpose.
Needs bash, curl and python3 on the path (on Windows: Git Bash).
"""
import base64
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "fetch-secrets.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None or shutil.which("curl") is None, reason="needs bash and curl")

REQUIRED = {
    "tallythis-database-url": "postgresql://app:pw%21@ep-host.neon.tech/neondb?sslmode=require&channel_binding=require",
    "tallythis-jwt-secret": "a" * 64,
    "tallythis-worker-service-token": "b" * 64,
    "tallythis-r2-access-key-id": "r2id123",
    "tallythis-r2-secret-access-key": "r2secret456",
    "tallythis-gemini-api-key": "AIzaFakeKeyForTests_-123",
}


class FakeGoogle(BaseHTTPRequestHandler):
    secrets: dict[str, str] = {}
    denied: set[str] = set()

    def log_message(self, *args):  # keep test output quiet
        pass

    def _send(self, status, body, ctype="application/json"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/computeMetadata/v1/"):
            if self.headers.get("Metadata-Flavor") != "Google":
                return self._send(403, "missing Metadata-Flavor")
            if path.endswith("/project/project-id"):
                return self._send(200, "test-project", "text/plain")
            if path.endswith("/service-accounts/default/token"):
                return self._send(200, json.dumps({"access_token": "tok", "expires_in": 3000, "token_type": "Bearer"}))
            return self._send(404, "")
        prefix = "/v1/projects/test-project/secrets/"
        if path.startswith(prefix) and path.endswith("/versions/latest:access"):
            if self.headers.get("Authorization") != "Bearer tok":
                return self._send(401, "{}")
            name = path[len(prefix):].split("/")[0]
            if name in self.denied:
                return self._send(403, "{}")
            if name not in self.secrets:
                return self._send(404, "{}")
            data = base64.b64encode(self.secrets[name].encode()).decode()
            return self._send(200, json.dumps({"name": name, "payload": {"data": data}}))
        self._send(404, "")


@pytest.fixture()
def google():
    FakeGoogle.secrets = dict(REQUIRED)
    FakeGoogle.denied = set()
    server = HTTPServer(("127.0.0.1", 0), FakeGoogle)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield FakeGoogle, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def run_script(base_url: str):
    out = Path(tempfile.mkdtemp(prefix="tallythis-run-"))
    shim = Path(tempfile.mkdtemp(prefix="tallythis-bin-"))
    env = dict(os.environ)
    env.update(
        TALLYTHIS_METADATA_URL=f"{base_url}/computeMetadata/v1",
        TALLYTHIS_SECRETMANAGER_URL=base_url,
        TALLYTHIS_RUN_DIR=str(out),
    )
    # The VM has python3; a Windows developer machine may only have python.
    if shutil.which("python3") is None or os.name == "nt":
        wrapper = shim / "python3"
        python = shutil.which("python") or "python"
        wrapper.write_text(f'#!/bin/sh\nexec "{Path(python).as_posix()}" "$@"\n', newline="\n")
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IEXEC)
        env["PATH"] = f"{shim.as_posix()}{os.pathsep}{env['PATH']}"
    # Git Bash can mangle the path; hand it a form it understands.
    env["TALLYTHIS_RUN_DIR"] = Path(out).as_posix()
    result = subprocess.run([BASH, SCRIPT.as_posix()], env=env, capture_output=True, text=True, timeout=60)
    return result, out


def read_env(directory: Path, name: str) -> dict[str, str]:
    values = {}
    for line in (directory / name).read_text().splitlines():
        key, _, value = line.partition("=")
        values[key] = value
    return values


def test_each_container_gets_only_the_secrets_it_uses(google):
    _, url = google
    result, out = run_script(url)
    assert result.returncode == 0, result.stderr

    gateway = read_env(out, "gateway.env")
    api = read_env(out, "api.env")
    worker = read_env(out, "worker.env")

    assert set(gateway) == {"DATABASE_URL", "JWT_SECRET"}
    assert set(api) == {
        "DATABASE_URL", "JWT_SECRET", "WORKER_SERVICE_TOKEN",
        "CLOUDFLARE_R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "GEMINI_API_KEY",
    }, "the optional Anthropic key is absent when it has no value"
    assert set(worker) == {"WORKER_SERVICE_TOKEN"}, "the worker must not receive the database or any API key"

    assert api["DATABASE_URL"] == REQUIRED["tallythis-database-url"], "special characters in the value are kept exactly"
    assert api["WORKER_SERVICE_TOKEN"] == worker["WORKER_SERVICE_TOKEN"], "API and worker must share the token"
    assert gateway["JWT_SECRET"] == api["JWT_SECRET"], "API and gateway must share the signing secret"


def test_an_optional_secret_is_included_once_it_has_a_value(google):
    handler, url = google
    handler.secrets["tallythis-anthropic-api-key"] = "sk-ant-test-0123456789"
    result, out = run_script(url)
    assert result.returncode == 0, result.stderr
    assert read_env(out, "api.env")["ANTHROPIC_API_KEY"] == "sk-ant-test-0123456789"


@pytest.mark.parametrize("missing", ["tallythis-database-url", "tallythis-jwt-secret", "tallythis-worker-service-token", "tallythis-r2-secret-access-key", "tallythis-gemini-api-key"])
def test_a_missing_required_secret_stops_the_start_and_names_it(google, missing):
    handler, url = google
    del handler.secrets[missing]
    result, _ = run_script(url)
    assert result.returncode != 0
    assert missing in result.stderr
    assert "set-secrets.sh" in result.stderr


def test_a_secret_the_vm_may_not_read_stops_the_start(google):
    handler, url = google
    handler.denied.add("tallythis-jwt-secret")
    result, _ = run_script(url)
    assert result.returncode != 0
    assert "tallythis-jwt-secret" in result.stderr


@pytest.mark.parametrize("bad", ["has space", 'has"quote', "has'quote", "has$dollar", "has\\backslash", "has`tick"])
def test_a_value_a_container_env_file_cannot_carry_is_refused_not_damaged(google, bad):
    handler, url = google
    handler.secrets["tallythis-gemini-api-key"] = bad
    result, out = run_script(url)
    assert result.returncode != 0
    assert "tallythis-gemini-api-key" in result.stderr
    assert bad not in result.stderr, "the value itself must never be printed"
    leaked = (out / "api.env").read_text() if (out / "api.env").exists() else ""
    assert bad not in leaked


@pytest.mark.parametrize("ending", ["\r\n", "\r", "\n", "\r\n\r\n"])
def test_a_line_ending_left_on_a_secret_by_windows_is_trimmed_not_refused(google, ending):
    """Found on the first real run: openssl on Windows added a carriage return, and the secret was refused."""
    handler, url = google
    handler.secrets["tallythis-jwt-secret"] = "c" * 64 + ending
    handler.secrets["tallythis-gemini-api-key"] = "AIzaFakeKeyForTests_-123" + ending
    result, out = run_script(url)
    assert result.returncode == 0, result.stderr
    api = read_env(out, "api.env")
    assert api["JWT_SECRET"] == "c" * 64, "the value is exactly the characters it was made of"
    assert api["GEMINI_API_KEY"] == "AIzaFakeKeyForTests_-123"
    assert "\r" not in (out / "api.env").read_text()


def test_whitespace_inside_a_value_is_still_refused_even_with_a_line_ending(google):
    handler, url = google
    handler.secrets["tallythis-jwt-secret"] = "has space\r\n"
    result, _ = run_script(url)
    assert result.returncode != 0
    assert "tallythis-jwt-secret" in result.stderr


@pytest.mark.skipif(os.name == "nt", reason="file modes are not meaningful on Windows")
def test_the_files_are_readable_by_their_owner_only(google):
    _, url = google
    result, out = run_script(url)
    assert result.returncode == 0, result.stderr
    for name in ("api.env", "gateway.env", "worker.env"):
        assert stat.S_IMODE((out / name).stat().st_mode) == 0o600
