// expect-count: 2
// C3: a lazily assigned browser singleton plus a WeakMap side channel for edit-success state.
import type { ReactElement } from "react";

interface QueryClient {
	readonly id: string;
}

const createContactsQueryClient = (): QueryClient => ({ id: "contacts" });

let browserQueryClient: QueryClient | undefined;
const contactEditSuccesses = new WeakMap<QueryClient, Set<string>>();

export const getContactsQueryClient = (): QueryClient => {
	if (globalThis.window === undefined) return createContactsQueryClient();
	browserQueryClient ??= createContactsQueryClient();
	return browserQueryClient;
};

export const markContactEditSuccess = (client: QueryClient, key: string): void => {
	const successes = contactEditSuccesses.get(client) ?? new Set<string>();
	successes.add(key);
	contactEditSuccesses.set(client, successes);
};

export const hasContactEditSuccess = (client: QueryClient, key: string): boolean =>
	contactEditSuccesses.get(client)?.has(key) === true;

export function EditSuccessBanner({ shown }: { readonly shown: boolean }): ReactElement | null {
	return shown ? <p>Saved</p> : null;
}
