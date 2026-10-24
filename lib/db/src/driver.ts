/**
 * Which database driver to use for a connection string.
 *
 * Neon (the real database) is reached over HTTP. A database on this computer, which only tests and
 * local checks use, is a plain Postgres that speaks the normal protocol. The choice is made by the
 * host name alone and only loopback names count as "this computer", so a real database can never be
 * mistaken for a local one.
 */
export function isLoopbackDatabaseUrl(connectionString: string): boolean {
  let host: string;
  try {
    host = new URL(connectionString).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}
