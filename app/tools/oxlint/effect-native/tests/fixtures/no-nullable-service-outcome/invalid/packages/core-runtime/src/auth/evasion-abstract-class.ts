// expect-count: 7
import { Effect } from "effect";

export interface PrincipalRecord {
	readonly principalId: string;
}

export class PrincipalError extends Error {}

/** An abstract class declares the port exactly as an interface does (A2/B5). */
export abstract class PrincipalRepositoryBase {
	abstract loadPrincipal(principalId: string): Promise<PrincipalRecord | undefined>;
	abstract claimNext(): Effect.Effect<PrincipalRecord | null, PrincipalError>;
	abstract readonly loadBinding: (bindingId: string) => Promise<PrincipalRecord | undefined>;
}

/** Ambient class declarations are port declarations too. */
declare class DeclaredPrincipalRepository {
	loadPrincipal(principalId: string): Promise<PrincipalRecord | undefined>;
}
void (undefined as unknown as DeclaredPrincipalRepository);

/** Overload signatures carry the public shape; the implementation is the private half. */
export class PrincipalRepository {
	loadPrincipal(principalId: string): Promise<PrincipalRecord | undefined>;
	loadPrincipal(principalId: string): Promise<PrincipalRecord | undefined> {
		void principalId;
		return Promise.resolve(undefined);
	}

	claimNext(): Effect.Effect<PrincipalRecord | null, PrincipalError> {
		return Effect.succeed(null);
	}
}
