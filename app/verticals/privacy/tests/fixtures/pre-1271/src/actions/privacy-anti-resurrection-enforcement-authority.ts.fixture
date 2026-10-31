import { Context, Effect, Layer } from 'effect';

import type { AntiResurrectionEnforcementReceipt } from '../../shared/domain/anti-resurrection.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';

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
