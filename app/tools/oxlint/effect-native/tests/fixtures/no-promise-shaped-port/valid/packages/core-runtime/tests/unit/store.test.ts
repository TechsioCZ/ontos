/** Tests are excluded by default (includeTests: false). */
export interface FakeStore {
	readonly load: () => Promise<string>;
}
export const fake = { load: async () => await Promise.resolve("x") };
