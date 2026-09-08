// expect-count: 2
export interface FakeStore {
	readonly load: () => Promise<string>;
}
export const fake = { load: async () => await Promise.resolve("x") };
