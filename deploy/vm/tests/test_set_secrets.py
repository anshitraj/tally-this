"""Runs deploy/vm/set-secrets.sh with a stand-in `gcloud` that stores what it is given in a folder, so the script can be
checked without touching Google: what is stored, under which name, and that no secret value is ever printed."""
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "set-secrets.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None or shutil.which("openssl") is None, reason="needs bash and openssl")

FAKE_GCLOUD = """#!/bin/sh
# Stand-in for gcloud: `secrets versions describe latest --secret=NAME` succeeds when STORE/NAME exists, and
# `secrets versions add NAME --data-file=-` saves standard input to STORE/NAME.
store="$STORE"
args="$*"
case "$args" in
  *"versions describe latest --secret="*)
    name=${args#*--secret=}; name=${name%% *}
    [ -f "$store/$name" ] && exit 0 || exit 1 ;;
  *"versions add "*)
    name=${args#*versions add }; name=${name%% *}
    cat > "$store/$name"; echo "Created version [1] of the secret [$name]."; exit 0 ;;
esac
exit 0
"""

ENV_FILE = """\
# a comment
DATABASE_URL="postgresql://app:pw%21@ep-host.neon.tech/neondb?sslmode=require&channel_binding=require"
GEMINI_API_KEY=AIzaFakeGeminiKey_0123456789-abc
ANTHROPIC_API_KEY='sk-ant-fake-0123456789'
STORAGE_ACCESS_KEY_ID=r2idfake123
STORAGE_SECRET_ACCESS_KEY=r2secretfake456
JWT_SECRET=should-never-be-copied
"""


def run(tmp_env: str, *args: str, preset: dict[str, str] | None = None):
    work = Path(tempfile.mkdtemp(prefix="tt-setsecrets-"))
    store = work / "store"
    store.mkdir()
    for name, value in (preset or {}).items():
        (store / name).write_text(value)
    shim = work / "bin"
    shim.mkdir()
    gcloud = shim / "gcloud"
    gcloud.write_text(FAKE_GCLOUD, newline="\n")  # a shell script must keep Unix line endings
    gcloud.chmod(gcloud.stat().st_mode | stat.S_IEXEC)
    # The script reads config.sh from its own folder, so give it a copy of the folder.
    folder = work / "vm"
    folder.mkdir()
    shutil.copy(SCRIPT, folder / "set-secrets.sh")
    (folder / "config.sh").write_text("PROJECT_ID=test-project\n", newline="\n")
    env_path = work / "test.env"
    env_path.write_text(tmp_env, newline="")
    env = dict(os.environ, STORE=store.as_posix(), PATH=f"{shim.as_posix()}{os.pathsep}{os.environ['PATH']}")
    result = subprocess.run([BASH, (folder / "set-secrets.sh").as_posix(), *[a.replace("{ENV}", env_path.as_posix()) for a in args]],
                            env=env, capture_output=True, text=True, timeout=90)
    return result, store


def test_copies_values_exactly_under_the_right_names_and_never_prints_them():
    result, store = run(ENV_FILE, "--from-env", "{ENV}")
    assert result.returncode == 0, result.stderr
    assert (store / "tallythis-database-url").read_text() == "postgresql://app:pw%21@ep-host.neon.tech/neondb?sslmode=require&channel_binding=require", "quotes are removed, the rest is exact"
    assert (store / "tallythis-gemini-api-key").read_text() == "AIzaFakeGeminiKey_0123456789-abc"
    assert (store / "tallythis-anthropic-api-key").read_text() == "sk-ant-fake-0123456789", "single quotes are removed too"
    assert (store / "tallythis-r2-access-key-id").read_text() == "r2idfake123", "the STORAGE_ names are accepted for R2"
    assert (store / "tallythis-r2-secret-access-key").read_text() == "r2secretfake456"
    shown = result.stdout + result.stderr
    for secret in ("pw%21", "AIzaFakeGeminiKey", "sk-ant-fake", "r2idfake123", "r2secretfake456", "ep-host.neon.tech"):
        assert secret not in shown, f"{secret} must never be printed"
    assert "characters" in result.stdout, "names and lengths are what is shown"


def test_the_signing_secret_in_the_file_is_not_copied_and_the_internal_ones_are_clean_random_values():
    result, store = run(ENV_FILE, "--from-env", "{ENV}")
    assert result.returncode == 0, result.stderr
    for name in ("tallythis-jwt-secret", "tallythis-worker-service-token"):
        value = (store / name).read_text()
        assert re.fullmatch(r"[0-9a-f]{64}", value), f"{name} must be exactly 64 hex characters, no line ending"
    assert "should-never-be-copied" not in (store / "tallythis-jwt-secret").read_text()


def test_windows_line_endings_in_the_file_do_not_end_up_in_the_secrets():
    result, store = run(ENV_FILE.replace("\n", "\r\n"), "--from-env", "{ENV}")
    assert result.returncode == 0, result.stderr
    assert (store / "tallythis-gemini-api-key").read_text() == "AIzaFakeGeminiKey_0123456789-abc"
    assert "\r" not in (store / "tallythis-database-url").read_text()


def test_a_value_a_container_cannot_carry_is_refused_and_not_stored():
    bad = ENV_FILE.replace("AIzaFakeGeminiKey_0123456789-abc", "has a space")
    result, store = run(bad, "--from-env", "{ENV}")
    assert result.returncode != 0
    assert "tallythis-gemini-api-key" in result.stderr
    assert "has a space" not in result.stdout + result.stderr
    assert not (store / "tallythis-gemini-api-key").exists()


def test_names_missing_from_the_file_are_skipped_and_existing_internal_secrets_are_kept():
    result, store = run("DATABASE_URL=postgresql://u:p@h/db\n", "--from-env", "{ENV}", preset={"tallythis-jwt-secret": "keepme"})
    assert result.returncode == 0, result.stderr
    assert (store / "tallythis-database-url").exists()
    assert not (store / "tallythis-gemini-api-key").exists()
    assert "skipped" in result.stdout
    assert (store / "tallythis-jwt-secret").read_text() == "keepme", "an internal secret that already has a value is not replaced"


def test_rotate_replaces_the_internal_secrets():
    result, store = run("DATABASE_URL=postgresql://u:p@h/db\n", "--from-env", "{ENV}", "--rotate", preset={"tallythis-jwt-secret": "old"})
    assert result.returncode == 0, result.stderr
    assert re.fullmatch(r"[0-9a-f]{64}", (store / "tallythis-jwt-secret").read_text())


def test_an_unknown_option_or_a_missing_file_stops_at_once():
    assert run("", "--nonsense")[0].returncode == 2
    assert run("", "--from-env", "/no/such/file.env")[0].returncode == 2
