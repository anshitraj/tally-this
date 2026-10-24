/**
 * Where a live Tally connection may point.
 *
 * The API used to forward whatever host and port the browser sent to the worker, which then connected
 * to it. That let any signed-in person make the server contact any address it could reach. This is the
 * first of two checks: the worker repeats it after resolving the name (backend/worker/app/connectors/
 * tally_target.py), where DNS answers can be checked too. Keep the two in step.
 *
 * - The connector is off by default in production: a cloud server's "localhost" is its own container,
 *   never the accountant's PC.
 * - The host must be this computer or an address an administrator listed in TALLY_ALLOWED_HOSTS.
 * - The port must be 9000 or listed in TALLY_ALLOWED_PORTS.
 */
type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f:]+$/;

export type TallyTargetCheck = { ok: true; host: string; port: number } | { ok: false; error: string };

function isProduction(env: Env) {
  return [env.NODE_ENV, env.APP_ENV].some(value => value?.trim().toLowerCase() === "production");
}

function items(value: string | undefined) {
  return (value ?? "").split(",").map(part => part.trim().toLowerCase()).filter(Boolean);
}

export function tallyConnectorEnabled(env: Env = process.env): boolean {
  const flag = (env.TALLY_CONNECTOR_ENABLED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  if (["0", "false", "no", "off"].includes(flag)) return false;
  return !isProduction(env);
}

// Never allowed, even when an administrator lists them: cloud metadata, link-local, unspecified and multicast.
const METADATA = new Set(["169.254.169.254", "100.100.100.200", "168.63.129.16", "192.0.0.192", "fd00:ec2::254"]);
function neverAllowed(host: string): boolean {
  if (METADATA.has(host)) return true;
  const v4 = IPV4.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || (a === 169 && b === 254) || (a >= 224 && a <= 239);
  }
  if (host.includes(":")) return host === "::" || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || host.startsWith("ff");
  return false;
}

function normalizeHost(raw: unknown): string | null {
  let host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return null;
  const v4 = IPV4.exec(host);
  if (v4) return v4.slice(1).every(part => Number(part) <= 255 && String(Number(part)) === part) ? host : null;
  if (host.includes(":")) return IPV6.test(host) && host.length <= 45 ? host : null;
  return NAME.test(host) ? host : null;
}

export function checkTallyTarget(rawHost: unknown, rawPort: unknown, env: Env = process.env): TallyTargetCheck {
  if (!tallyConnectorEnabled(env)) {
    return { ok: false, error: "Live Tally connection is switched off on this server. Export the report from Tally and upload the file instead." };
  }
  const port = typeof rawPort === "number" || typeof rawPort === "string" ? Number(rawPort) : NaN;
  const allowedPorts = new Set([9000, ...items(env.TALLY_ALLOWED_PORTS).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 65535)]);
  if (!Number.isInteger(port) || !allowedPorts.has(port)) return { ok: false, error: "That Tally port is not allowed." };

  const host = normalizeHost(rawHost ?? "localhost");
  if (!host) return { ok: false, error: "That is not a valid Tally address." };
  if (neverAllowed(host)) return { ok: false, error: "That address is not allowed." };
  if (!new Set([...LOCAL_HOSTS, ...items(env.TALLY_ALLOWED_HOSTS)]).has(host)) {
    return { ok: false, error: "That address is not allowed. Live Tally connections are limited to this computer unless an administrator adds the address." };
  }
  return { ok: true, host, port };
}
