/**
 * How the API proves who it is to the Python worker.
 *
 * The worker answers only callers that send the shared WORKER_SERVICE_TOKEN (see
 * backend/worker/app/security.py). In production the worker refuses everything without one, and the
 * API's callers already fall back to the built-in readers when the worker says no, so a missing token
 * costs speed, not correctness. Set the same value on both services.
 */
export function workerUrl(env: Record<string, string | undefined> = process.env): string {
  return env.PYTHON_WORKER_URL ?? "http://localhost:8091";
}

/** Headers for a call to the worker. Add your own (for example a JSON content type) as `extra`. */
export function workerHeaders(extra: Record<string, string> = {}, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = (env.WORKER_SERVICE_TOKEN ?? "").trim();
  return token ? { "X-Service-Token": token, ...extra } : { ...extra };
}
