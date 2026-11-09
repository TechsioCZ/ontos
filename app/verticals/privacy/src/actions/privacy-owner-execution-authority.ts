import { Context, Effect } from 'effect';
import type { OperationalScope } from '@app/core-runtime';

import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

export interface OwnerExecutionAuthorityContext {
  readonly actionInvocationId: string;
  readonly dispatchOriginator:
    | { readonly actionInvocationId: string; readonly compositionRevision: string }
    | undefined;
  readonly handoff: PrivacyMeasureHandoff;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly scope: OperationalScope;
  readonly tenantId: string;
}

/**
 * Private owner boundary for execution receipts. Public Actions provide only
 * the request identity; an adapter must load and attest the actual result.
 */
export interface OwnerExecutionAuthorityService {
  readonly resolve: (
    request: OwnerExecutionOutcomeRequest,
    context: OwnerExecutionAuthorityContext,
  ) => Effect.Effect<OwnerExecutionAuthorityResult, PrivacyActionRejected | PrivacyOperationPersistenceError>;
}

export class OwnerExecutionAuthority extends Context.Service<OwnerExecutionAuthority, OwnerExecutionAuthorityService>()(
  '@app/privacy/actions/privacy-owner-execution-authority/OwnerExecutionAuthority',
) {}

export const ownerExecutionAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'Owner execution authority is not configured',
      }),
    ),
}) satisfies OwnerExecutionAuthorityService;
