"""Where the Tally connector may connect.

The connector posts XML to a Tally server. The address used to come straight from the request body, so any
signed-in person could make the worker contact any host it could reach: a cloud metadata service, an internal
database, another service on the private network. Now:

* the connector is off by default in production (a cloud worker's "localhost" is the worker's own container,
  never the accountant's PC, so there is nothing legitimate for it to reach);
* the host must be on an allow-list (this computer by default, plus whatever an administrator adds);
* the host must resolve only to addresses that are safe for that entry, and the connection is made to the
  address that was checked, so a changing DNS answer cannot redirect it afterwards;
* link-local, metadata, unspecified and multicast addresses are never allowed, even if listed.
"""
from __future__ import annotations

import ipaddress
import os
import re
import socket
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ..security import is_production

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class TallyTargetError(ValueError):
    """The requested Tally address is not allowed. The message is safe to show to the person."""


LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
DEFAULT_PORTS = frozenset({9000})

# Cloud metadata and management endpoints. Blocked outright, whatever an administrator lists.
_METADATA = frozenset(
    ipaddress.ip_address(value)
    for value in ("169.254.169.254", "fd00:ec2::254", "100.100.100.200", "168.63.129.16", "192.0.0.192")
)

_NAME = re.compile(r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
_ON = {"1", "true", "yes", "on"}
_OFF = {"0", "false", "no", "off"}


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def _items(value: str) -> list[str]:
    return [part.strip().lower() for part in value.split(",") if part.strip()]


def connector_enabled(env: Mapping[str, str] | None = None) -> bool:
    env = _env(env)
    flag = env.get("TALLY_CONNECTOR_ENABLED", "").strip().lower()
    if flag in _ON:
        return True
    if flag in _OFF:
        return False
    return not is_production(env)


def allowed_hosts(env: Mapping[str, str] | None = None) -> frozenset[str]:
    return LOCAL_HOSTS | frozenset(_items(_env(env).get("TALLY_ALLOWED_HOSTS", "")))


def allowed_ports(env: Mapping[str, str] | None = None) -> frozenset[int]:
    extra: set[int] = set()
    for item in _items(_env(env).get("TALLY_ALLOWED_PORTS", "")):
        if item.isdigit() and 1 <= int(item) <= 65535:
            extra.add(int(item))
    return DEFAULT_PORTS | frozenset(extra)


def normalize_host(raw: str) -> str:
    host = (raw or "").strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if not host:
        raise TallyTargetError("Enter the address of the computer running Tally.")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if not _NAME.match(host):
        raise TallyTargetError("That is not a valid Tally address.")
    return host


@dataclass(frozen=True)
class TallyTarget:
    host: str  # what the person asked for
    address: str  # the checked IP address the connection is made to
    port: int

    @property
    def url(self) -> str:
        netloc = f"[{self.address}]" if ipaddress.ip_address(self.address).version == 6 else self.address
        return f"http://{netloc}:{self.port}"


def resolve_addresses(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: list[str] = []
    for info in infos:
        address = str(info[4][0]).split("%", 1)[0]
        if address not in seen:
            seen.append(address)
    return seen


def _unwrap(ip: IPAddress) -> IPAddress:
    # ::ffff:127.0.0.1 is just 127.0.0.1 written another way.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def _never_allowed(ip: IPAddress) -> bool:
    if ip in _METADATA or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
        return True
    # Python also calls ::1 "reserved" (it sits inside ::/8), but it is this computer, which is the one
    # address that is meant to be allowed.
    if ip.is_loopback:
        return False
    return ip.is_reserved


def validate_target(
    host: str,
    port: int | str,
    *,
    env: Mapping[str, str] | None = None,
    resolver: Callable[[str, int], list[str]] | None = None,
) -> TallyTarget:
    env = _env(env)
    if not connector_enabled(env):
        raise TallyTargetError(
            "Live Tally connection is switched off on this server. Export the report from Tally and upload the file instead."
        )
    try:
        number = int(port)
    except (TypeError, ValueError):
        raise TallyTargetError("That is not a valid Tally port.") from None
    if number not in allowed_ports(env):
        raise TallyTargetError("That Tally port is not allowed.")

    name = normalize_host(host)
    if name not in allowed_hosts(env):
        raise TallyTargetError(
            "That address is not allowed. Live Tally connections are limited to this computer unless an administrator adds the address."
        )

    try:
        raw_addresses = (resolver or resolve_addresses)(name, number)
    except OSError:
        raise TallyTargetError("That address could not be found.") from None
    if not raw_addresses:
        raise TallyTargetError("That address could not be found.")

    local = name in LOCAL_HOSTS
    safe: list[IPAddress] = []
    for raw in raw_addresses:
        ip = _unwrap(ipaddress.ip_address(raw))
        if _never_allowed(ip):
            raise TallyTargetError("That address is not allowed.")
        # "localhost" must only ever mean this computer, whatever a hosts file or DNS says.
        if local and not ip.is_loopback:
            raise TallyTargetError("That address is not allowed.")
        safe.append(ip)

    chosen = next((ip for ip in safe if ip.version == 4), safe[0])
    return TallyTarget(host=name, address=str(chosen), port=number)
