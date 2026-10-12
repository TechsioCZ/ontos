import { Context, Effect, Layer } from 'effect';

import type {
  PrivacyDispositionDecisionAuthorityResult,
  PrivacyDispositionDecisionRequest,
  RetentionEvaluation,
} from '../../shared/domain/privacy-retention-disposition.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface RetentionDispositionAuthorityContext {
  readonly actionInvocationId: string;
  readonly asOf: string;
  readonly evaluation: RetentionEvaluation;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Private governance seam for disposition authority, reasons, and outcomes. */
export interface RetentionDispositionAuthorityService {
  readonly resolve: (
    request: PrivacyDispositionDecisionRequest,
    context: RetentionDispositionAuthorityContext,
  ) => Effect.Effect<
    PrivacyDispositionDecisionAuthorityResult,
    PrivacyActionRejected | PrivacyOperationPersistenceError
  >;
}

export class RetentionDispositionAuthority extends Context.Service<
  RetentionDispositionAuthority,
  RetentionDispositionAuthorityService
>()('@app/privacy/actions/privacy-retention-disposition-authority/RetentionDispositionAuthority') {}

const retentionDispositionAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'Retention Disposition governance authority is not configured',
      }),
    ),
}) satisfies RetentionDispositionAuthorityService;

export const RetentionDispositionAuthorityUnavailableLive = Layer.succeed(
  RetentionDispositionAuthority,
  retentionDispositionAuthorityUnavailable,
);
