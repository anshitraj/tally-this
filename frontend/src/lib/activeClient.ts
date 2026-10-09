export interface ActiveClient {
  id: number | null;
  name: string;
  gstin?: string;
  accounting: "Tally" | "Zoho" | "Other";
  linkId?: number | null;
}

const KEY = "finverify_active_client";

export function getActiveClient(): ActiveClient | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as ActiveClient : null;
  } catch {
    return null;
  }
}

export function setActiveClient(client: ActiveClient) {
  localStorage.setItem(KEY, JSON.stringify(client));
  window.dispatchEvent(new Event("finverify-client"));
}
