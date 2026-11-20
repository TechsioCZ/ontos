import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PartyRefSchema } from '@app/party-registry/resources/party';

import {
  CommercePortalAccountSubjectSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptSnapshotSchema,
  EnrollmentOwnerOperationSnapshotSchema,
  ReadEnrollmentAttemptInputSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { RetailEnrollmentRestartContextSchema } from '../../src/enrollment/journeys/retail-enrollment-restart.ts';
import { resolveRetailEnrollmentPartyProducer } from '../../src/enrollment/orchestration/owner-effect-registry.ts';

const uid = (number: number) => `78000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const legalEntityId = uid(2);
const partyId = uid(3);
const principalId = uid(4);
const providerOwnerInvocationId = uid(5);
const at = '2026-11-20T08:00:00.000Z';
const scope = { legalEntityId, tenantId };
const partyRef = Schema.decodeUnknownSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
});
const accountSubject = Schema.decodeUnknownSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  providerSubjectId: 'exact-enrolling-provider-subject',
  subjectType: 'user',
});

const attempt = (id: number, source?: number, mask: 0 | 1 = 1): EnrollmentAttemptSnapshot => {
  const base = {
    accountSubject,
    compositionRevision: 'a'.repeat(64),
    createdAt: at,
    createdByPrincipalId: principalId,
    intentDigest: 'b'.repeat(64),
    intentKey: source === undefined ? `retail-original-${id}` : `commerce.retail-restart:${uid(source)}:${mask}`,
    journey: source === undefined ? 'RETAIL_SELF_ENROLLMENT' : 'EXISTING_ACCOUNT',
    originatorActionInvocationId: uid(id + 1000),
    portalEnrollmentAttemptId: uid(id),
    revision: 4,
    state: 'FAILED',
    targetLegalEntityId: legalEntityId,
    tenantId,
    updatedAt: at,
  };
  if (source !== undefined) {
    return Schema.decodeUnknownSync(EnrollmentAttemptSnapshotSchema)({ ...base, targetResourceId: uid(source) });
  }
  return Schema.decodeUnknownSync(EnrollmentAttemptSnapshotSchema)(base);
};

interface PartyJournalOverride {
  readonly ownerModuleKey?: string;
  readonly portalEnrollmentAttemptId?: string;
  readonly required?: boolean;
  readonly resultReference?: string;
  readonly status?: (typeof EnrollmentOwnerOperationSnapshotSchema.Encoded)['status'];
  readonly tenantId?: string;
  readonly transitionKey?: string;
}

interface InvalidPartyJournalCase {
  readonly label: string;
  readonly overrides: PartyJournalOverride;
}

const operation = (
  owner: EnrollmentAttemptSnapshot,
  kind: 'provider' | 'party',
  overrides: PartyJournalOverride = {},
): EnrollmentOwnerOperationSnapshot =>
  Schema.decodeUnknownSync(EnrollmentOwnerOperationSnapshotSchema)({
    actorPrincipalId: principalId,
    createdAt: at,
    outcomeCode: kind === 'provider' ? 'provider_account_created' : 'party_candidate_created',
    ownerInvocationId:
      kind === 'provider' ? providerOwnerInvocationId : uid(2000 + Number(owner.portalEnrollmentAttemptId.slice(-4))),
    ownerModuleKey: kind === 'provider' ? 'commerce.portal-auth' : 'party.registry',
    portalEnrollmentAttemptId: owner.portalEnrollmentAttemptId,
    portalEnrollmentOwnerOperationId: uid(
      3000 + Number(owner.portalEnrollmentAttemptId.slice(-4)) + (kind === 'provider' ? 100 : 0),
    ),
    requestDigest: 'c'.repeat(64),
    required: true,
    resultReference: kind === 'provider' ? owner.portalEnrollmentAttemptId : partyId,
    revision: 1,
    status: 'SUCCEEDED',
    tenantId,
    transitionKey: kind === 'provider' ? 'provider.account.create' : 'party.candidate.submit',
    updatedAt: at,
    ...overrides,
  });

interface StoredAttempt {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly operations: readonly EnrollmentOwnerOperationSnapshot[];
}
const stored = (
  owner: EnrollmentAttemptSnapshot,
  operations: readonly EnrollmentOwnerOperationSnapshot[],
): StoredAttempt => ({
  attempt: owner,
  operations,
});
const restartProof = (source: number, retainedParty = true) => {
  const base = {
    directoryOwnerInvocationIds: [],
    providerOwnerInvocationId,
    registration: { displayName: 'Retail Person', email: 'retail@example.test' },
    retainedMask: retainedParty ? 1 : 0,
    sourceAttemptId: uid(source),
  };
  if (retainedParty) {
    return Schema.decodeUnknownSync(RetailEnrollmentRestartContextSchema)({ ...base, partyId });
  }
  return Schema.decodeUnknownSync(RetailEnrollmentRestartContextSchema)(base);
};
type RestartProof = ReturnType<typeof restartProof>;

/** Build actual owner routine rows, then let the production schemas and persistence map them. */
const projectedAttemptRow = (owner: EnrollmentAttemptSnapshot) => ({
  attempt_outcome: 'FOUND',
  authentication_namespace_id: owner.accountSubject?.authenticationNamespaceId ?? null,
  composition_revision: owner.compositionRevision,
  created_at: DateTime.formatIso(owner.createdAt),
  created_by_principal_id: owner.createdByPrincipalId,
  intent_digest: owner.intentDigest,
  intent_key: owner.intentKey,
  invitation_id: null,
  journey: owner.journey,
  last_failure_code: null,
  last_failure_reason: null,
  last_owner_invocation_id: null,
  lease_expires_at: null,
  lease_owner: null,
  lease_token: null,
  portal_enrollment_attempt_id: owner.portalEnrollmentAttemptId,
  provider_subject_id: owner.accountSubject?.providerSubjectId ?? null,
  revision: owner.revision,
  state: owner.state,
  subject_type: owner.accountSubject?.subjectType ?? null,
  target_legal_entity_id: owner.targetLegalEntityId ?? null,
  target_resource_id: owner.targetResourceId ?? null,
  tenant_id: owner.tenantId,
  terminated_at: null,
  updated_at: DateTime.formatIso(owner.updatedAt),
});

const projectedOperationRow = (entry?: EnrollmentOwnerOperationSnapshot) => {
  if (entry === undefined) {
    return {
      completed_at: null,
      failure_code: null,
      failure_reason: null,
      operation_actor_principal_id: null,
      operation_id: null,
      operation_lease_expires_at: null,
      operation_lease_owner: null,
      operation_lease_token: null,
      operation_revision: null,
      operation_status: null,
      outcome_code: null,
      owner_invocation_id: null,
      owner_module_key: null,
      reconciliation_ref: null,
      request_digest: null,
      required: null,
      result_digest: null,
      result_reference: null,
      transition_key: null,
    };
  }
  return {
    completed_at: entry.completedAt === undefined ? null : DateTime.formatIso(entry.completedAt),
    failure_code: entry.failureCode ?? null,
    failure_reason: entry.failureReason ?? null,
    operation_actor_principal_id: entry.actorPrincipalId,
    operation_id: entry.portalEnrollmentOwnerOperationId,
    operation_lease_expires_at: null,
    operation_lease_owner: null,
    operation_lease_token: null,
    operation_revision: entry.revision,
    operation_status: entry.status,
    outcome_code: entry.outcomeCode ?? null,
    owner_invocation_id: entry.ownerInvocationId,
    owner_module_key: entry.ownerModuleKey,
    reconciliation_ref: entry.reconciliationRef ?? null,
    request_digest: entry.requestDigest,
    required: entry.required,
    result_digest: entry.resultDigest ?? null,
    result_reference: entry.resultReference ?? null,
    transition_key: entry.transitionKey,
  };
};

const projectedRow = (owner: EnrollmentAttemptSnapshot, entry?: EnrollmentOwnerOperationSnapshot) => ({
  ...projectedAttemptRow(owner),
  ...projectedOperationRow(entry),
});

const nativeInvoker = (
  attempts: readonly StoredAttempt[] = [],
  proofs: ReadonlyMap<string, RestartProof> = new Map(),
) => {
  const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.sync(() => {
      const id = Schema.decodeUnknownSync(EnrollmentAttemptIdSchema)(values.at(0));
      const owner = attempts.find((entry) => entry.attempt.portalEnrollmentAttemptId === id);
      let rows: readonly object[] = [];
      if (routine.name === 'read_retail_enrollment_restart_context') {
        const proof = proofs.get(id);
        rows = proof === undefined ? [] : [{ context: proof }];
      } else if (routine.name === 'read_portal_enrollment_attempt') {
        if (owner !== undefined) {
          rows =
            owner.operations.length === 0
              ? [projectedRow(owner.attempt)]
              : owner.operations.map((entry) => projectedRow(owner.attempt, entry));
        }
      } else if (routine.name === 'read_portal_enrollment_originator') {
        rows =
          owner === undefined
            ? []
            : [{ originator_action_invocation_id: owner.attempt.originatorActionInvocationId ?? null }];
      } else {
        throw new Error(`Unexpected routine in read-only Party producer proof: ${routine.name}`);
      }
      return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows);
    });
  return { invoke };
};

const resolve = (owner: StoredAttempt, transaction = nativeInvoker(), target = partyRef) =>
  resolveRetailEnrollmentPartyProducer(transaction, scope, {
    attempt: owner.attempt,
    operations: owner.operations,
    partyRef: target,
  });

it.effect('maps the fixture through the real native Attempt reader and journal reader', () =>
  Effect.gen(function* mapNativeFixture() {
    const source = attempt(20);
    const provider = operation(source, 'provider');
    const party = operation(source, 'party');
    const journal = [provider, party];
    const persistence = commerceEnrollmentAttemptPersistenceForTransaction(
      nativeInvoker([stored(source, journal)]),
      scope,
    );
    const identity = Schema.decodeUnknownSync(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: source.portalEnrollmentAttemptId,
      tenantId,
    });
    expect(yield* persistence.read(identity)).toEqual(source);
    expect(yield* persistence.readOperations(identity)).toEqual([party, provider]);
  }),
);

it.effect('returns the original retail Party producer and its exact Create idempotency key', () =>
  Effect.gen(function* resolveOriginalProducer() {
    const source = attempt(20);
    const journal = [operation(source, 'provider'), operation(source, 'party')];
    const proof = yield* resolve(stored(source, journal));
    expect(proof.attempt).toEqual(source);
    expect(proof.operations).toEqual(journal);
    expect(proof.ownerInvocationId).toBe(journal[1]?.ownerInvocationId);
    expect(proof.providerOwnerInvocationId).toBe(providerOwnerInvocationId);
  }),
);

it.effect('keeps an EXISTING_ACCOUNT attempt that actually created the Party instead of choosing the root', () =>
  Effect.gen(function* retainIntermediateProducer() {
    const root = attempt(20);
    const producer = attempt(21, 20, 0);
    const journal = [operation(producer, 'party')];
    const transaction = nativeInvoker(
      [stored(root, [operation(root, 'provider')])],
      new Map([[producer.portalEnrollmentAttemptId, restartProof(20, false)]]),
    );
    const proof = yield* resolve(stored(producer, journal), transaction);
    expect(proof.attempt.portalEnrollmentAttemptId).toBe(producer.portalEnrollmentAttemptId);
    expect(proof.ownerInvocationId).toBe(journal[0]?.ownerInvocationId);
    expect(proof.providerOwnerInvocationId).toBe(providerOwnerInvocationId);
  }),
);

it.effect('resolves retained Party from its intermediate producer across two later restarts', () =>
  Effect.gen(function* traverseLaterRestarts() {
    const root = attempt(20);
    const producer = attempt(21, 20, 0);
    const later = attempt(22, 21);
    const current = attempt(23, 22);
    const producerJournal = [operation(producer, 'party')];
    const transaction = nativeInvoker(
      [stored(root, [operation(root, 'provider')]), stored(producer, producerJournal), stored(later, [])],
      new Map([
        [producer.portalEnrollmentAttemptId, restartProof(20, false)],
        [later.portalEnrollmentAttemptId, restartProof(21)],
        [current.portalEnrollmentAttemptId, restartProof(22)],
      ]),
    );
    const proof = yield* resolve(stored(current, []), transaction);
    expect(proof.attempt.portalEnrollmentAttemptId).toBe(producer.portalEnrollmentAttemptId);
    expect(proof.operations).toEqual(producerJournal);
    expect(proof.ownerInvocationId).toBe(producerJournal[0]?.ownerInvocationId);
    expect(proof.providerOwnerInvocationId).toBe(providerOwnerInvocationId);
  }),
);

it.effect('resolves a retained original retail Party through the validated immediate predecessor', () =>
  Effect.gen(function* resolveOriginalPredecessor() {
    const source = attempt(20);
    const current = attempt(21, 20);
    const journal = [operation(source, 'provider'), operation(source, 'party')];
    const proof = yield* resolve(
      stored(current, []),
      nativeInvoker([stored(source, journal)], new Map([[current.portalEnrollmentAttemptId, restartProof(20)]])),
    );
    expect(proof.attempt.portalEnrollmentAttemptId).toBe(source.portalEnrollmentAttemptId);
    expect(proof.ownerInvocationId).toBe(journal[1]?.ownerInvocationId);
  }),
);

it.effect.each<InvalidPartyJournalCase>([
  { label: 'unfinished', overrides: { status: 'IN_PROGRESS' } },
  { label: 'failed', overrides: { status: 'FAILED' } },
  { label: 'indeterminate', overrides: { status: 'INDETERMINATE' } },
  { label: 'different Party', overrides: { resultReference: uid(99) } },
  { label: 'different owner', overrides: { ownerModuleKey: 'commerce.customer-context' } },
  { label: 'different transition', overrides: { transitionKey: 'party.customer.enroll' } },
  { label: 'different Attempt', overrides: { portalEnrollmentAttemptId: uid(99) } },
  { label: 'different Tenant', overrides: { tenantId: uid(99) } },
  { label: 'optional operation', overrides: { required: false } },
])('rejects $label Party journal evidence', ({ overrides }) =>
  Effect.gen(function* rejectInvalidPartyJournal() {
    const source = attempt(20);
    const outcome = yield* Effect.result(
      resolve(stored(source, [operation(source, 'provider'), operation(source, 'party', overrides)])),
    );
    expect(Result.isFailure(outcome)).toBe(true);
  }),
);

it.effect('rejects a Party producer without proven provider creation', () =>
  Effect.gen(function* rejectMissingProviderProof() {
    const source = attempt(20);
    expect(Result.isFailure(yield* Effect.result(resolve(stored(source, [operation(source, 'party')]))))).toBe(true);
  }),
);

it.effect('rejects non-succeeded provider creation evidence', () =>
  Effect.gen(function* rejectUnfinishedProviderProof() {
    const source = attempt(20);
    expect(
      Result.isFailure(
        yield* Effect.result(
          resolve(stored(source, [operation(source, 'provider', { status: 'FAILED' }), operation(source, 'party')])),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect.each([
  { label: 'foreign Tenant', overrides: { tenantId: uid(99) } },
  { label: 'foreign selling company', overrides: { targetLegalEntityId: uid(99) } },
  {
    label: 'changed provider subject',
    overrides: { accountSubject: { ...accountSubject, providerSubjectId: 'someone-else' } },
  },
])('rejects a predecessor with $label', ({ overrides }) =>
  Effect.gen(function* rejectInvalidPredecessor() {
    const source = Schema.decodeUnknownSync(EnrollmentAttemptSnapshotSchema)({
      ...Schema.encodeSync(EnrollmentAttemptSnapshotSchema)(attempt(20)),
      ...overrides,
    });
    const current = attempt(21, 20);
    const transaction = nativeInvoker(
      [stored(source, [operation(source, 'provider'), operation(source, 'party')])],
      new Map([[current.portalEnrollmentAttemptId, restartProof(20)]]),
    );
    expect(Result.isFailure(yield* Effect.result(resolve(stored(current, []), transaction)))).toBe(true);
  }),
);

it('rejects a changed provider namespace at the native account subject schema boundary', () => {
  expect(
    Schema.is(CommercePortalAccountSubjectSchema)({
      ...accountSubject,
      authenticationNamespaceId: 'another.provider.v1',
    }),
  ).toBe(false);
});

it.effect('rejects a retained Party mismatch from the native predecessor proof', () =>
  Effect.gen(function* rejectRetainedPartyMismatch() {
    const source = attempt(20);
    const current = attempt(21, 20);
    const transaction = nativeInvoker(
      [stored(source, [operation(source, 'provider'), operation(source, 'party')])],
      new Map([
        [
          current.portalEnrollmentAttemptId,
          Schema.decodeUnknownSync(RetailEnrollmentRestartContextSchema)({
            ...Schema.encodeSync(RetailEnrollmentRestartContextSchema)(restartProof(20)),
            partyId: uid(99),
          }),
        ],
      ]),
    );
    expect(Result.isFailure(yield* Effect.result(resolve(stored(current, []), transaction)))).toBe(true);
  }),
);

it.effect('rejects a proof pointing past the immediate native predecessor', () =>
  Effect.gen(function* rejectSkippedPredecessor() {
    const source = attempt(20);
    const current = attempt(22, 21);
    const transaction = nativeInvoker(
      [stored(source, [operation(source, 'provider'), operation(source, 'party')])],
      new Map([[current.portalEnrollmentAttemptId, restartProof(20)]]),
    );
    expect(Result.isFailure(yield* Effect.result(resolve(stored(current, []), transaction)))).toBe(true);
  }),
);

it.effect('rejects a restart without its native predecessor proof', () =>
  Effect.gen(function* rejectMissingNativeProof() {
    expect(Result.isFailure(yield* Effect.result(resolve(stored(attempt(21, 20), []))))).toBe(true);
  }),
);

it.effect('rejects a cyclic native restart chain', () =>
  Effect.gen(function* rejectCyclicChain() {
    const left = attempt(20, 21);
    const right = attempt(21, 20);
    const transaction = nativeInvoker(
      [stored(left, []), stored(right, [])],
      new Map([
        [left.portalEnrollmentAttemptId, restartProof(21)],
        [right.portalEnrollmentAttemptId, restartProof(20)],
      ]),
    );
    expect(Result.isFailure(yield* Effect.result(resolve(stored(right, []), transaction)))).toBe(true);
  }),
);

it.effect('bounds retained predecessor traversal instead of following an unlimited chain', () =>
  Effect.gen(function* rejectUnboundedChain() {
    const chain = Array.from({ length: 34 }, (_, index) => attempt(20 + index, index === 0 ? undefined : 19 + index));
    const proofs = new Map(
      chain.slice(1).map((entry, index) => [entry.portalEnrollmentAttemptId, restartProof(20 + index)]),
    );
    const transaction = nativeInvoker(
      chain.map((entry, index) =>
        stored(entry, index === 0 ? [operation(entry, 'provider'), operation(entry, 'party')] : []),
      ),
      proofs,
    );
    const current = attempt(53, 52);
    expect(Result.isFailure(yield* Effect.result(resolve(stored(current, []), transaction)))).toBe(true);
  }),
);
