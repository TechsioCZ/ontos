import { Context } from 'effect';
import type { Effect } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { OperationContextUnavailable } from './errors.ts';

export interface PersistedScopeRecord {
  readonly bindingAuthenticationNamespaceId?: null | string;
  readonly bindingIssuingLegalEntityId?: null | string;
  readonly bindingPrincipalId: null | string;
  readonly bindingRevision?: null | number;
  readonly bindingRevokedAt: Date | null;
  readonly bindingStatus: null | string;
  readonly bindingSubjectType?: null | string;
  readonly bindingTenantId: null | string;
  readonly impersonatorStatus?: null | string;
  readonly impersonatorTenantId?: null | string;
  readonly legalEntityStatus: null | string;
  readonly legalEntityTenantId: null | string;
  /**
   * `core.principals.kind` of the acting person. The enforcement seam reads the kind through its own
   * `AccessPrincipalKindSource` port (O64), so a caller that already loaded this profile can answer
   * that port without a second query (CUTOVER-PLAN §3.1 step 1).
   */
  readonly principalKind?: null | string;
  readonly principalStatus: null | string;
  readonly principalTenantId: null | string;
  readonly tenantStatus: null | string;
}

export interface OperationalScopeRepository {
  readonly load: (
    principal: TrustedPrincipalContext,
  ) => Effect.Effect<PersistedScopeRecord, OperationContextUnavailable>;
}

export class OperationalScopeRepositoryContext extends Context.Service<
  OperationalScopeRepositoryContext,
  OperationalScopeRepository
>()('@app/core-runtime/operations/repository-context/OperationalScopeRepositoryContext') {}
