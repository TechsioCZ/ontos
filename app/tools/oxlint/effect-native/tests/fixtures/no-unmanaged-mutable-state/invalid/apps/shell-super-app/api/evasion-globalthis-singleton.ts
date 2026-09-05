// expect-count: 2
// Evasion: the singleton is hung off `globalThis` instead of a module binding, so there is no
// `let` declarator to find. Same defect as C3's `browserQueryClient`, one scope wider.
interface RuntimeGlobal {
	__ontosCauses?: Map<string, unknown>;
	__ontosRuntime?: { readonly id: string };
}

const container = globalThis as unknown as RuntimeGlobal;

export const getRuntime = (): { readonly id: string } => {
	container.__ontosRuntime ??= { id: "root" };
	return container.__ontosRuntime;
};

export const rememberCause = (key: string, cause: unknown): void => {
	container.__ontosCauses ??= new Map<string, unknown>();
	container.__ontosCauses.set(key, cause);
};
