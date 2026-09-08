// expect-count: 2
/** Evasion: the same module-scope Promise port in a `.mts` file. */
export interface ScopedTransactionPort {
	install(id: string): Promise<void>;
}

export const install = async (id: string) => {
	await Promise.resolve(id);
};
