import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import type { OperationalScope } from '@app/core-runtime';

import { CommunicationTenantIdSchema } from '../catalog/vocabulary.ts';

/** The source references a caller selects; the Tenant and Legal Entity are never selected, only trusted. */
type SourceScopeSelection = Pick<CommunicationRequestScope, 'counterpartyRef' | 'profileRef' | 'storefrontRef'>;

/** The exact scope under construction: the dimensions the selection names plus the trusted Tenant and Legal Entity. */
interface ExactScopeDraft {
  counterpartyRef?: NonNullable<CommunicationRequestScope['counterpartyRef']>;
  legalEntityId?: NonNullable<CommunicationRequestScope['legalEntityId']>;
  profileRef?: NonNullable<CommunicationRequestScope['profileRef']>;
  storefrontRef?: NonNullable<CommunicationRequestScope['storefrontRef']>;
  tenantId: CommunicationRequestScope['tenantId'];
}

/**
 * The exact scope of a Read: the trusted Tenant and Legal Entity plus the source references the caller selected. An absent
 * reference selects only requests that have none, so the scope is matched exactly and never widened (ACC-02).
 */
export const exactScopeOf = (
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
  selection: SourceScopeSelection = {},
): CommunicationRequestScope => {
  const exact: ExactScopeDraft = { ...selection, tenantId: CommunicationTenantIdSchema.make(scope.tenantId) };
  if (scope.legalEntityId !== undefined) {
    exact.legalEntityId = scope.legalEntityId;
  }
  return exact;
};
