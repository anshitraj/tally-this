"""Where the Tally connector may connect: this computer, plus what an administrator adds."""
import asyncio

import httpx
import pytest

from app.connectors.tally_gateway import build_export_request, fetch_from_tally
from app.connectors.tally_target import (
    TallyTargetError,
    allowed_hosts,
    allowed_ports,
    connector_enabled,
    normalize_host,
    validate_target,
)

DEV: dict[str, str] = {}
PRODUCTION_ON = {"APP_ENV": "production", "TALLY_CONNECTOR_ENABLED": "true"}


def resolving(*addresses: str):
    return lambda host, port: list(addresses)


# ── the switch ──────────────────────────────────────────────────────────────

def test_connector_is_on_for_development_and_off_for_production():
    assert connector_enabled(DEV) is True
    assert connector_enabled({"APP_ENV": "production"}) is False
    assert connector_enabled({"NODE_ENV": "production"}) is False


def test_the_switch_can_be_set_either_way():
    assert connector_enabled({"APP_ENV": "production", "TALLY_CONNECTOR_ENABLED": "true"}) is True
    assert connector_enabled({"TALLY_CONNECTOR_ENABLED": "false"}) is False


def test_nothing_connects_while_the_connector_is_off():
    with pytest.raises(TallyTargetError, match="switched off"):
        validate_target("localhost", 9000, env={"APP_ENV": "production"})


# ── this computer is allowed, nothing else is ───────────────────────────────

@pytest.mark.parametrize("host", ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "::1", "[::1]"])
def test_this_computer_is_allowed(host):
    target = validate_target(host, 9000, env=DEV)
    assert target.port == 9000
    assert target.address in {"127.0.0.1", "::1"}


@pytest.mark.parametrize(
    "host",
    [
        "169.254.169.254",  # cloud metadata
        "10.0.0.5",  # a private network address
        "192.168.1.20",
        "172.16.0.1",
        "example.com",
        "evil.example.com",
        "0.0.0.0",
        "2130706433",  # 127.0.0.1 written as one number
        "127.1",  # 127.0.0.1 shortened
        "0x7f.0.0.1",
        "017700000001",
        "::ffff:127.0.0.1",
        "metadata.google.internal",
        "",
        "   ",
    ],
)
def test_other_addresses_are_refused(host):
    with pytest.raises(TallyTargetError):
        validate_target(host, 9000, env=DEV, resolver=resolving("127.0.0.1"))


@pytest.mark.parametrize(
    "host",
    ["http://localhost", "localhost/", "localhost:9000", "user@localhost", "local host", "localhost#x", "localhost?x=1", "a..b", "-bad.example.com", "x" * 300],
)
def test_malformed_addresses_are_refused_before_anything_is_looked_up(host):
    def never(host, port):
        raise AssertionError("must not resolve a malformed address")

    with pytest.raises(TallyTargetError):
        validate_target(host, 9000, env=DEV, resolver=never)


def test_the_cloud_metadata_address_is_refused_even_if_an_administrator_lists_it():
    env = {"TALLY_ALLOWED_HOSTS": "169.254.169.254,100.100.100.200,168.63.129.16,fd00:ec2::254"}
    for host in ("169.254.169.254", "100.100.100.200", "168.63.129.16", "fd00:ec2::254"):
        with pytest.raises(TallyTargetError):
            validate_target(host, 9000, env=env)


def test_link_local_unspecified_and_multicast_are_never_allowed():
    env = {"TALLY_ALLOWED_HOSTS": "tally.office.lan"}
    for bad in ("169.254.10.10", "0.0.0.0", "224.0.0.1", "fe80::1"):
        with pytest.raises(TallyTargetError):
            validate_target("tally.office.lan", 9000, env=env, resolver=resolving(bad))


# ── "localhost" must only ever mean this computer ───────────────────────────

def test_localhost_resolving_somewhere_else_is_refused():
    with pytest.raises(TallyTargetError):
        validate_target("localhost", 9000, env=DEV, resolver=resolving("10.0.0.9"))
    with pytest.raises(TallyTargetError):
        validate_target("localhost", 9000, env=DEV, resolver=resolving("127.0.0.1", "10.0.0.9"))


def test_localhost_that_resolves_to_this_computer_connects_to_the_checked_address():
    target = validate_target("localhost", 9000, env=DEV, resolver=resolving("::1", "127.0.0.1"))
    assert target.address == "127.0.0.1"
    assert target.url == "http://127.0.0.1:9000"
    assert validate_target("::1", 9000, env=DEV).url == "http://[::1]:9000"


# ── an administrator can add a computer on the office network ───────────────

def test_an_administrator_can_allow_a_computer_on_the_office_network():
    env = {"TALLY_ALLOWED_HOSTS": "tally.office.lan, 192.168.1.20"}
    assert validate_target("tally.office.lan", 9000, env=env, resolver=resolving("192.168.1.20")).address == "192.168.1.20"
    assert validate_target("192.168.1.20", 9000, env=env).address == "192.168.1.20"
    # Still not any other computer on that network.
    with pytest.raises(TallyTargetError):
        validate_target("192.168.1.21", 9000, env=env)


def test_a_listed_name_that_starts_resolving_to_the_metadata_address_is_refused():
    env = {"TALLY_ALLOWED_HOSTS": "tally.office.lan"}
    with pytest.raises(TallyTargetError):
        validate_target("tally.office.lan", 9000, env=env, resolver=resolving("169.254.169.254"))
    with pytest.raises(TallyTargetError):
        validate_target("tally.office.lan", 9000, env=env, resolver=resolving("192.168.1.20", "169.254.169.254"))


def test_the_connection_uses_the_address_that_was_checked():
    answers = iter([["192.168.1.20"], ["169.254.169.254"]])  # a rebinding attack changes the answer on the second look
    env = {"TALLY_ALLOWED_HOSTS": "tally.office.lan"}
    target = validate_target("tally.office.lan", 9000, env=env, resolver=lambda h, p: next(answers))
    assert target.url == "http://192.168.1.20:9000"  # the later, hostile answer is never asked for


def test_a_name_that_cannot_be_found_is_refused():
    def missing(host, port):
        raise OSError("not found")

    with pytest.raises(TallyTargetError, match="could not be found"):
        validate_target("tally.office.lan", 9000, env={"TALLY_ALLOWED_HOSTS": "tally.office.lan"}, resolver=missing)


# ── ports ───────────────────────────────────────────────────────────────────

def test_only_the_tally_port_is_allowed_unless_more_are_listed():
    assert allowed_ports(DEV) == {9000}
    assert allowed_ports({"TALLY_ALLOWED_PORTS": "9001, 9002, nope, 0, 70000"}) == {9000, 9001, 9002}
    validate_target("localhost", 9000, env=DEV)
    validate_target("localhost", 9001, env={"TALLY_ALLOWED_PORTS": "9001"})


@pytest.mark.parametrize("port", [22, 80, 443, 5432, 8080, 8091, 0, 65536, -1, "abc", None])
def test_other_ports_are_refused(port):
    with pytest.raises(TallyTargetError):
        validate_target("localhost", port, env=DEV)


def test_defaults():
    assert allowed_hosts(DEV) == {"localhost", "127.0.0.1", "::1"}
    assert normalize_host("[::1]") == "::1"


# ── what is sent to Tally ───────────────────────────────────────────────────

def test_a_company_name_cannot_add_its_own_tags_to_the_request():
    hostile = "ACME</SVCURRENTCOMPANY><TALLYREQUEST>Import Data</TALLYREQUEST><X>"
    xml = build_export_request(hostile, "2026-04-01", "2026-04-30")
    assert "&lt;/SVCURRENTCOMPANY&gt;" in xml
    assert "<X>" not in xml
    assert xml.count("<TALLYREQUEST>") == 1  # only the real "Export Data"
    assert "<SVFROMDATE>20260401</SVFROMDATE>" in xml


@pytest.mark.parametrize("report", ["Day Book</REPORTNAME><X>", "", "a" * 61, "Day\nBook"])
def test_report_names_are_restricted(report):
    with pytest.raises(TallyTargetError):
        build_export_request("ACME", "2026-04-01", "2026-04-30", report)


@pytest.mark.parametrize("value", ["2026-4-1", "01/04/2026", "20260401</SVFROMDATE><X>", "tomorrow"])
def test_dates_must_be_real_dates(value):
    with pytest.raises(TallyTargetError):
        build_export_request("ACME", value, "2026-04-30")


def test_company_names_must_be_present_and_plain():
    for bad in ("", "   ", "x" * 201, "line\nbreak"):
        with pytest.raises(TallyTargetError):
            build_export_request(bad, "2026-04-01", "2026-04-30")


# ── the whole fetch, with a pretend Tally ───────────────────────────────────

def run(coro):
    return asyncio.run(coro)


def pretend_tally(seen: list, status=200, body=b"<ENVELOPE></ENVELOPE>"):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, content=body)

    return httpx.MockTransport(handler)


def test_a_refused_address_sends_nothing(monkeypatch):
    for key in ("APP_ENV", "NODE_ENV", "TALLY_ALLOWED_HOSTS", "TALLY_CONNECTOR_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    seen: list = []
    result = run(fetch_from_tally("169.254.169.254", 9000, "ACME", "2026-04-01", "2026-04-30", transport=pretend_tally(seen)))
    assert result["ok"] is False and result["blocked"] is True
    assert seen == []


def test_a_refused_address_in_production_sends_nothing(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("TALLY_CONNECTOR_ENABLED", raising=False)
    seen: list = []
    result = run(fetch_from_tally("localhost", 9000, "ACME", "2026-04-01", "2026-04-30", transport=pretend_tally(seen)))
    assert result["blocked"] is True and "switched off" in result["errors"][0]
    assert seen == []


def test_this_computer_is_contacted_at_the_checked_address(monkeypatch):
    for key in ("APP_ENV", "NODE_ENV", "TALLY_ALLOWED_HOSTS", "TALLY_CONNECTOR_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    seen: list = []
    run(fetch_from_tally("localhost", 9000, "ACME", "2026-04-01", "2026-04-30", transport=pretend_tally(seen)))
    assert len(seen) == 1
    assert seen[0].url.host in {"127.0.0.1", "::1"}
    assert seen[0].url.port == 9000
    assert b"<SVCURRENTCOMPANY>ACME</SVCURRENTCOMPANY>" in seen[0].content


def test_a_redirect_from_the_server_is_not_followed(monkeypatch):
    for key in ("APP_ENV", "NODE_ENV", "TALLY_ALLOWED_HOSTS", "TALLY_CONNECTOR_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    result = run(fetch_from_tally("localhost", 9000, "ACME", "2026-04-01", "2026-04-30", transport=httpx.MockTransport(handler)))
    assert result["ok"] is False and "HTTP 302" in result["errors"][0]
    assert len(seen) == 1
