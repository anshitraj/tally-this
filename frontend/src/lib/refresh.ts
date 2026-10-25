import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Ask again for what a change has just made out of date.
 *
 * Marking a query out of date is not enough when its first request is still on its way: with nothing to show yet,
 * React Query hands the new request to the one in flight, and that one was answered from the state before the change.
 * The screen then keeps saying "nothing uploaded" after a file was uploaded. So stop what is in flight first, then ask.
 */
export async function refreshAfterChange(client: QueryClient, keys: QueryKey[]): Promise<void> {
  await Promise.all(keys.map(queryKey => client.cancelQueries({ queryKey })));
  await Promise.all(keys.map(queryKey => client.invalidateQueries({ queryKey })));
}
