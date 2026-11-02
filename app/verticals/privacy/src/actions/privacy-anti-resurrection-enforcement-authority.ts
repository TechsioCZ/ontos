import { Context, Effect, Layer, Schema } from 'effect';

import type { AntiResurrectionEnforcementReceipt } from '../../shared/domain/anti-resurrection.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { OwnerExecutionAuthorityResultSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';
import type { PreparedOwnerExecution } from './privacy-owner-execution-authority.ts';
import { preparedOwnerExecutionAuthority } from './privacy-owner-execution-authority.ts';

interface AntiResurrectionEnforcementAuthorityContext {
  readonly actionInvocationId: string;
  readonly authority: OwnerExecutionAuthorityResult;
  readonly handoff: PrivacyMeasureHandoff;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly request: OwnerExecutionOutcomeRequest;
  readonly tenantId: string;
}

/** Owner-local recovery/import/replay/projection gate receipt. */
export interface AntiResurrectionEnforcementAuthorityService {
  readonly resolve: (
    context: AntiResurrectionEnforcementAuthorityContext,
  ) => Effect.Effect<AntiResurrectionEnforcementReceipt, PrivacyActionRejected | PrivacyOperationPersistenceError>;
}

export class AntiResurrectionEnforcementAuthority extends Context.Service<
  AntiResurrectionEnforcementAuthority,
  AntiResurrectionEnforcementAuthorityService
>()('@app/privacy/actions/privacy-anti-resurrection-enforcement-authority/AntiResurrectionEnforcementAuthority') {}

export const antiResurrectionEnforcementAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new PrivacyOperationPersistenceError({
        code: 'privacy_operation_persistence_unavailable',
        reason: 'Owner-local anti-resurrection enforcement authority is not configured',
      }),
    ),
}) satisfies AntiResurrectionEnforcementAuthorityService;

export const AntiResurrectionEnforcementAuthorityUnavailableLive = Layer.succeed(
  AntiResurrectionEnforcementAuthority,
  antiResurrectionEnforcementAuthorityUnavailable,
);

/** Existing immutable enforcement evidence, not an external enforcement mutation. */
export const preparedAntiResurrectionAuthority = (
  prepared: PreparedOwnerExecution,
  receipt: AntiResurrectionEnforcementReceipt,
): AntiResurrectionEnforcementAuthorityService => ({
  resolve: Effect.fn('AntiResurrectionEnforcementAuthority.resolvePrepared')(function* resolvePrepared(context) {
    yield* preparedOwnerExecutionAuthority(prepared).resolve(context.request, context);
    if (!Schema.toEquivalence(OwnerExecutionAuthorityResultSchema)(context.authority, prepared.authority)) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Prepared enforcement receipt belongs to another owner outcome',
      });
    }
    return receipt;
  }),
});
