import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Result, Schema } from 'effect';

import { CreatePrivacySubjectPayloadSchema } from '../../shared/actions/create-privacy-subject.ts';
import type { CreatePrivacySubjectPayload } from '../../shared/actions/create-privacy-subject.ts';
import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import type { PrivacySubjectOwnerEvidence, PrivacySubjectRecord } from '../../shared/domain/privacy-subject.ts';
import {
  PrivacySubjectRecordSchema,
  isPrivacyInstantAtOrBefore,
  isPrivacyInstantBefore,
} from '../../shared/domain/privacy-subject.ts';
import { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

export interface PreparedPrivacySubject {
  readonly actionInvocationId: string;
  readonly before: PrivacySubjectRecord | undefined;
  readonly compositionRevision: string;
  readonly observation: Result.Result<PrivacySubjectOwnerEvidence, PrivacyOperationPersistenceError> | undefined;
  readonly payload: CreatePrivacySubjectPayload;
  readonly scope: OperationalScope;
}

export const privacySubjectPreparationScopeMatches = (
  expected: OperationalScope,
  candidate: OperationalScope,
): boolean =>
  expected.legalEntityId !== undefined &&
  candidate.legalEntityId === expected.legalEntityId &&
  candidate.correlationId === expected.correlationId &&
  candidate.audience === expected.audience &&
  candidate.traceId === expected.traceId &&
  Schema.toEquivalence(TrustedPrincipalContextSchema)(candidate, expected);

export const preparedSubjectUnavailable = () =>
  new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'The exact invocation-local Party evidence changed, expired, or is unavailable',
  });

export const checkPreparedSubjectValidity = Effect.fn('PrivacySubjectPreparation.checkValidity')(
  function* checkValidity(prepared: PreparedPrivacySubject): Effect.fn.Return<void, PrivacyOperationPersistenceError> {
    const { observation } = prepared;
    if (observation === undefined) {
      return yield* Effect.void;
    }
    const evidence = yield* Result.match(observation, { onFailure: Effect.fail, onSuccess: Effect.succeed });
    const now = DateTime.formatIso(yield* DateTime.now);
    if (
      !isPrivacyInstantAtOrBefore(evidence.observedAt, now) ||
      evidence.typeAssertions.some(
        (assertion) =>
          !isPrivacyInstantAtOrBefore(assertion.validFrom, now) ||
          (assertion.validTo !== null && !isPrivacyInstantBefore(now, assertion.validTo)),
      )
    ) {
      return yield* preparedSubjectUnavailable();
    }
    return yield* Effect.void;
  },
);

export const resolvePreparedSubjectParty = Effect.fn('PrivacySubjectPreparation.resolveParty')(function* resolveParty(
  prepared: PreparedPrivacySubject,
  requested: {
    readonly partyRef: typeof PrivacyPartyRefSchema.Type;
    readonly scope: OperationalScope;
    readonly write: boolean;
  },
): Effect.fn.Return<PrivacySubjectOwnerEvidence, PrivacyOperationPersistenceError> {
  if (
    prepared.observation === undefined ||
    prepared.payload.subject.kind !== 'DATA_SUBJECT' ||
    requested.write !== (prepared.before === undefined) ||
    !Schema.toEquivalence(PrivacyPartyRefSchema)(requested.partyRef, prepared.payload.subject.partyRef) ||
    !privacySubjectPreparationScopeMatches(prepared.scope, requested.scope)
  ) {
    return yield* preparedSubjectUnavailable();
  }
  yield* checkPreparedSubjectValidity(prepared);
  return yield* Result.match(prepared.observation, { onFailure: Effect.fail, onSuccess: Effect.succeed });
});

export const validatePreparedSubjectIntent = (
  prepared: PreparedPrivacySubject,
  input: {
    readonly actionInvocationId: string;
    readonly current: PrivacySubjectRecord | undefined;
    readonly subject: PrivacySubjectRecord;
  },
) =>
  input.actionInvocationId === prepared.actionInvocationId &&
  Schema.toEquivalence(CreatePrivacySubjectPayloadSchema)(input.subject, prepared.payload) &&
  (prepared.before === undefined
    ? input.current === undefined
    : input.current !== undefined && Schema.toEquivalence(PrivacySubjectRecordSchema)(prepared.before, input.current))
    ? Effect.void
    : Effect.fail(preparedSubjectUnavailable());

/** Preserve retained identity-conflict precedence before consuming prepared Party observations. */
export const validateRetainedSubjectWriteIntent = (
  current: PrivacySubjectRecord,
  proposed: PrivacySubjectRecord,
): Effect.Effect<void, PrivacyOperationPersistenceError> => {
  const { ownerAdmission: _retainedAdmission, ...retainedIntent } = current;
  const { ownerAdmission: _callerAdmission, ...proposedIntent } = proposed;
  return Schema.toEquivalence(PrivacySubjectRecordSchema)(retainedIntent, proposedIntent)
    ? Effect.void
    : Effect.fail(
        new PrivacyOperationPersistenceError({
          code: 'privacy_operation_conflict',
          reason: 'Privacy Subject identity conflict',
        }),
      );
};
