// expect-count: 2
import { Effect } from 'effect';

type PrincipalRecord = Readonly<{ readonly status: string }>;

/** Not reported: a data record, and it has no effectful member. */
export interface PrincipalManagementInput {
  readonly principalId: string;
}

export interface PrincipalManagementRepositoryService {
  readonly loadPrincipal: (
    tenantId: string,
    principalId: string,
  ) => Promise<PrincipalRecord | undefined>;
  readonly updatePrincipalStatus: (input: PrincipalManagementInput) => Promise<void>;
}

/** A second untagged contract in the same module, this one Effect-returning. */
export interface PrincipalAuditGateway {
  record(event: { readonly kind: string }): Effect.Effect<void, Error>;
}

export const loadPrincipal = (
  repository: PrincipalManagementRepositoryService,
  gateway: PrincipalAuditGateway,
): Effect.Effect<void, Error> => gateway.record({ kind: 'load' });
