// expect-count: 3
/** Evasion: the Promise-returning member type sits inside a union, so the annotation is not a bare TSFunctionType. */
export interface PrincipalManagementPersistence {
	readonly createPrincipal: ((input: string) => Promise<string>) | undefined;
	readonly deletePrincipal?: (() => Promise<void>) | null;
}

export type RevokeSession = ((sessionId: string) => Promise<boolean>) | undefined;
