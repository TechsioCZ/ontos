import { Context, Effect, Layer } from 'effect';

import type { DsrOwnerTaskAuthorityResult, DsrOwnerTaskRequest } from '../../shared/domain/privacy-dsr.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface DsrOwnerTaskAuthorityContext {
  readonly actionInvocationId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * Private owner boundary for DSR execution. The public Action can identify a
 * task, but only this seam may attest its current status and owner receipt.
 */
export interface DsrOwnerTaskAuthorityService {
  readonly resolve: (
    request: DsrOwnerTaskRequest,
    context: DsrOwnerTaskAuthorityContext,
  ) => Effect.Effect<DsrOwnerTaskAuthorityResult, PrivacyActionRejected | PrivacyOperationPersistenceError>;
}

export class DsrOwnerTaskAuthority extends Context.Service<DsrOwnerTaskAuthority, DsrOwnerTaskAuthorityService>()(
  '@app/privacy/actions/privacy-dsr-owner-task-authority/DsrOwnerTaskAuthority',
) {}

export const dsrOwnerTaskAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'DSR owner task authority is not configured',
      }),
    ),
}) satisfies DsrOwnerTaskAuthorityService;

export const DsrOwnerTaskAuthorityUnavailableLive = Layer.succeed(
  DsrOwnerTaskAuthority,
  dsrOwnerTaskAuthorityUnavailable,
);
