import { Context, Effect, Layer } from 'effect';

import type {
  ProcessingInterventionAuthorityRequest,
  ProcessingInterventionAuthorityResult,
} from '../../shared/domain/privacy-processing-eligibility.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface ProcessingInterventionAuthorityContext {
  readonly actionInvocationId: string;
  readonly asOf: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Private authority for the current objection/restriction state. */
export interface ProcessingInterventionAuthorityService {
  readonly resolve: (
    request: ProcessingInterventionAuthorityRequest,
    context: ProcessingInterventionAuthorityContext,
  ) => Effect.Effect<ProcessingInterventionAuthorityResult, PrivacyOperationPersistenceError>;
}

export class ProcessingInterventionAuthority extends Context.Service<
  ProcessingInterventionAuthority,
  ProcessingInterventionAuthorityService
>()('@app/privacy/actions/processing-intervention-authority/ProcessingInterventionAuthority') {}

export const processingInterventionAuthorityUnavailable = Object.freeze({
  resolve: (..._args: readonly unknown[]) =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'Processing Intervention authority is not configured',
      }),
    ),
}) satisfies ProcessingInterventionAuthorityService;

export const ProcessingInterventionAuthorityUnavailableLive = Layer.succeed(
  ProcessingInterventionAuthority,
  processingInterventionAuthorityUnavailable,
);
