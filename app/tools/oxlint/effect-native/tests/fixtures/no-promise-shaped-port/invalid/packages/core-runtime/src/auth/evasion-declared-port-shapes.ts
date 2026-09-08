// expect-count: 2
/** Evasion: declared Promise ports that are neither a method signature nor a property function type. */
export interface PortRegistry {
	readonly [key: string]: () => Promise<void>;
}

export declare function loadPrincipal(id: string): Promise<string>;
