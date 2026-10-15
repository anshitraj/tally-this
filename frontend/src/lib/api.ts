/**
 * Shared reading of API replies for page queries.
 *
 * A reply that is not OK used to be handed to the page as if it were data, so a lapsed session or
 * a server hiccup turned into "x.filter is not a function" and a blank screen. Reading it through
 * here makes the query fail cleanly instead; pages then show their empty state and the app says
 * that something did not load.
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function readJson<T = any>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = body && typeof body === "object" ? body.message || body.error : null;
    throw new ApiError(response.status, typeof message === "string" && message ? message : `The server answered ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Fetches a path under the app base and reads it with {@link readJson}. */
export function getJsonOrThrow<T = any>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return fetch(`${base}${path}`, init).then(response => readJson<T>(response));
}
