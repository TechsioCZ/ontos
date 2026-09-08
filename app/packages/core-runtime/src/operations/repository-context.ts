import { Context } from 'effect';
import type { Effect } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { OperationContextUnavailable } from './errors.ts';

export interface PersistedScopeRecord {
  readonly bindingPrincipalId: null | string;
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: null | string;
  readonly bindingTenantId: null | string;
  readonly impersonatorStatus?: null | string;
  readonly impersonatorTenantId?: null | string;
  readonly legalEntityStatus: null | string;
  readonly legalEntityTenantId: null | string;
  readonly principalStatus: null | string;
  readonly principalTenantId: null | string;
  readonly tenantStatus: null | string;
}

export interface OperationalScopeRepository {
  readonly load: (
    principal: TrustedPrincipalContext
  ) => Effect.Effect<PersistedScopeRecord, OperationContextUnavailable>;
}

export class OperationalScopeRepositoryContext extends Context.Service<
  OperationalScopeRepositoryContext,
  OperationalScopeRepository
>()(
  '@app/core-runtime/operations/repository-context/OperationalScopeRepositoryContext'
) {}
