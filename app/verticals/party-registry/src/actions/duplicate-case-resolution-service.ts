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
) =>
  Effect.succeed({
    resolve: (payload: ConfirmDuplicatePartiesPayload, invocationId: string) =>
      transitionDuplicateCandidateCase(transaction, {
        actionInvocationId: invocationId,
        candidateCaseId: payload.caseRef.resourceId,
        expectedRevision: payload.expectedRevision,
        outcome,
        reason: payload.reason,
        tenantId,
      }),
  });
