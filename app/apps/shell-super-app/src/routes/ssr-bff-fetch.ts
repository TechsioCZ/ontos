/** Node and the browser reach the Shell BFF at its URL; only Workers have a self service binding. */
export const ssrBffFetch = (): typeof globalThis.fetch | undefined => undefined;
