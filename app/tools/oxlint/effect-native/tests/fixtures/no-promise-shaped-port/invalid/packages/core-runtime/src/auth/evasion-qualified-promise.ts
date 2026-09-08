// expect-count: 2
/** Evasion: `globalThis.Promise` is still the global promise. */
export interface SystemPrincipalContext {
	load(id: string): globalThis.Promise<string>;
}

export const load = (id: string): globalThis.Promise<string> => Promise.resolve(id);
