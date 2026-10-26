import { useEffect, useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface LiveTally {
  /** The server has answered. Until then nothing is hidden. */
  checked: boolean;
  /** Can this server reach the accountant's own TallyPrime? Not on the hosted site. */
  available: boolean;
  /** Why not, in words for the person. */
  message: string;
}

let request: Promise<Omit<LiveTally, "checked">> | null = null;

function ask() {
  // ?check=0 asks only whether the feature is offered; it does not contact Tally.
  request ??= fetch(`${BASE}/api/jobs/tally/status?check=0`)
    .then(response => (response.ok ? response.json() : null))
    .then(data => ({ available: data?.available !== false, message: typeof data?.message === "string" ? data.message : "" }))
    .catch(() => {
      request = null;
      return { available: true, message: "" };
    });
  return request;
}

/**
 * Whether sending straight to Tally is offered on this site. The hosted site cannot reach a person's
 * own computer, so it says so instead of showing a button that cannot work.
 */
export function useLiveTally(): LiveTally {
  const [state, setState] = useState<LiveTally>({ checked: false, available: true, message: "" });
  useEffect(() => {
    let cancelled = false;
    void ask().then(answer => {
      if (!cancelled) setState({ checked: true, ...answer });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
