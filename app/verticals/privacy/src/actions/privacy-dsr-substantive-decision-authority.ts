import { Context, Effect, Layer } from 'effect';

import type {
  DsrSubstantiveDecisionAuthorityResult,
  DsrSubstantiveDecisionRequest,
} from '../../shared/domain/privacy-dsr.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

interface DsrSubstantiveDecisionAuthorityContext {
  readonly actionInvocationId: string;
  readonly asOf: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Private policy/version/provenance authority for substantive DSR decisions. */
export interface DsrSubstantiveDecisionAuthorityService {
  readonly resolve: (
    request: DsrSubstantiveDecisionRequest,
    context: DsrSubstantiveDecisionAuthorityContext,
  ) => Effect.Effect<DsrSubstantiveDecisionAuthorityResult, PrivacyActionRejected | PrivacyOperationPersistenceError>;
}

export class DsrSubstantiveDecisionAuthority extends Context.Service<
  DsrSubstantiveDecisionAuthority,
  DsrSubstantiveDecisionAuthorityService
>()('@app/privacy/actions/privacy-dsr-substantive-decision-authority/DsrSubstantiveDecisionAuthority') {}

export const dsrSubstantiveDecisionAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'DSR substantive decision authority is not configured',
      }),
    ),
}) satisfies DsrSubstantiveDecisionAuthorityService;

export const DsrSubstantiveDecisionAuthorityUnavailableLive = Layer.succeed(
  DsrSubstantiveDecisionAuthority,
  dsrSubstantiveDecisionAuthorityUnavailable,
);
