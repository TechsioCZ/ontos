import { Effect, Option, Result } from "effect";

export interface PrincipalRecord {
	readonly principalId: string;
}

export class PrincipalNotFoundError extends Error {}

/** The A2/B5 target shape: absence is an `Option`, or a typed failure. */
export interface PrincipalManagementRepositoryService {
	readonly loadPrincipal: (
		principalId: string,
	) => Effect.Effect<Option.Option<PrincipalRecord>, PrincipalNotFoundError>;
	readonly requirePrincipal: (principalId: string) => Effect.Effect<PrincipalRecord, PrincipalNotFoundError>;
	readonly decodePrincipal: (raw: string) => Effect.Effect<Result.Result<PrincipalRecord, string>, never>;
	loadStatus(principalId: string): Promise<PrincipalRecord>;
	readonly principalId?: string;
	readonly onMissing?: (reason: string) => void;
	readonly listPrincipals: (tenantId: string) => Promise<readonly PrincipalRecord[]>;
}

/** B5 explicitly says not to mechanically replace every `undefined`: sync helpers stay as they are. */
export const parseTenantId = (raw: string): string | undefined => (raw === "" ? undefined : raw);

export function findFirst(rows: readonly PrincipalRecord[]): PrincipalRecord | null {
	return rows[0] ?? null;
}

export const cachedPrincipal: PrincipalRecord | undefined = undefined;
