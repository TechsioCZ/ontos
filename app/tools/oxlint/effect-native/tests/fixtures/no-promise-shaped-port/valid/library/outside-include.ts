/** Outside `include`: never reported. */
export interface AnyStore {
	readonly load: () => Promise<string>;
}
export const store = { load: async () => await Promise.resolve("x") };
