// expect-count: 2
/** Evasion: the port is an abstract class instead of an interface. */
export abstract class PrincipalManagementPersistence {
	abstract createPrincipal(input: string): Promise<string>;

	abstract deletePrincipal(id: string): Promise<void>;
}
