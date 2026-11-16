import { withPartyClientSourcePrivacyRequirement } from '../services/party-client-source-privacy.service.ts';
import type { PartyClientSourceScope } from '../services/party-client-source-evidence.service.ts';
import { Effect, Schema } from 'effect';

import type { ConfirmDuplicatePartiesPayload } from '../../shared/actions/confirm-duplicate-parties.ts';
import { PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import { DuplicateCandidateConflict } from '../../shared/domain/matching-contracts.ts';
import { transitionDuplicateCandidateCase } from '../services/party-matching-persistence.service.ts';

export const DuplicateCaseResolutionErrorSchema = Schema.Union([
  DuplicateCandidateConflict,
  PartyPersistenceUnavailable,
]);

export const duplicateCaseResolutionService = (
  transaction: Parameters<typeof transitionDuplicateCandidateCase>[0],
  tenantId: string,
  outcome: Parameters<typeof transitionDuplicateCandidateCase>[1]['outcome'],
  entrypointKey: string,
  sourceScope?: PartyClientSourceScope,
) =>
  Effect.succeed({
    resolve: (payload: ConfirmDuplicatePartiesPayload, invocationId: string) => {
      const input: Parameters<typeof transitionDuplicateCandidateCase>[1] = {
        actionInvocationId: invocationId,
        candidateCaseId: payload.caseRef.resourceId,
        expectedRevision: payload.expectedRevision,
        outcome,
        reason: payload.reason,
        tenantId,
      };
      if (sourceScope !== undefined) {
        Object.assign(input, { sourceScope });
      }
      return transitionDuplicateCandidateCase(transaction, input).pipe(
        withPartyClientSourcePrivacyRequirement(entrypointKey),
      );
    },
  });
