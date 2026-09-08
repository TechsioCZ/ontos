// expect-count: 6
// A6: request identity declared as ordinary fields and ports on the Core operation scope.
export interface OperationalScope {
	readonly correlationId: string;
	readonly principalId: string;
	readonly traceId?: string;
}

export interface ResolveOperationalScopeInput {
	readonly correlationId: string;
	readonly legalEntityScope: 'forbidden' | 'optional' | 'required';
}

export interface OperationalScopeRepository {
	/** Type-level port: the parameter list *is* the contract. */
	readonly load: (correlationId: string, principalId: string) => Promise<OperationalScope>;
}

export type ScopeReader = {
	readonly read: (input: { readonly principalId: string; readonly traceparent: string }) => void;
};

export const resolveScope = ({ correlationId, principalId }: ResolveOperationalScopeInput) =>
	`${correlationId}:${principalId}`;
