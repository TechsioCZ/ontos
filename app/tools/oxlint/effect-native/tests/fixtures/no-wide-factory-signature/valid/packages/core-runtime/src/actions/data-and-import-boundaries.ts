import { Effect } from 'effect';

// Audit B4 correction: scalar identity/href factories are data, not collaborators.
export const makeInvocationIdentity = (tenant: string, action: string, seed: string) =>
  Effect.succeed(`${tenant}:${action}:${seed}`);
export const makeCustomerHref = (lang: string, id: string, term: string, page: number) =>
  `/${lang}/${id}?q=${term}&page=${page}`;

interface QueryOptions { filter: string; page?: number; }
export const buildQuery = (options: QueryOptions) => Effect.succeed(options.filter);

// A same-spelled parameter is not an Effect import.
interface StoreOptions { store: unknown; }
export function host(Effect: { succeed: (input: unknown) => unknown }) {
  return { makeStore: (options: StoreOptions) => Effect.succeed(options.store) };
}
