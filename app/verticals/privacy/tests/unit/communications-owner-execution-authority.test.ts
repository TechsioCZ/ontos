import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  readVerifiedGatewayPrivacyDispatch,
  RegisteredGatewayPrivacyDispatchSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Match, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  communicationsReceiptSubject,
  fingerprintCommunicationsOwnerHandoff,
  resolveCommunicationsOwnerExecutionReceipt,
} from '../../src/integrations/communications-owner-execution-authority.ts';
import {
  OwnerExecutionOutcomeSchema,
  PrivacyMeasureHandoffSchema,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { makeMeasureExecutionFixture } from '../support/measure-execution.fixture.ts';

const ownerScope = {
  controllerRef: 'controller-1',
  requestedScopePartRefs: ['communications.history', 'communications.attachment-link-references'],
  requestedScopeRef: 'scope-1',
  trustedLookups: [
    {
      _tag: 'SUBJECT_REFERENCE',
      lookupRef: 'lookup-1',
      moduleId: 'party.registry',
      resourceId: 'party-1',
      resourceType: 'party',
    },
  ],
};

it.effect('fingerprints a Communications handoff exactly as its owner does, owner scope included', () =>
  Effect.gen(function* fingerprintContract() {
    const crypto = yield* Crypto.Crypto;
    const fixture = makeMeasureExecutionFixture('75000000-0000-4000-8000-000000000001');
    const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
      ...fixture.handoff,
      ownerScope,
      owningCapability: 'communications.core',
    });
    const reordered = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
      ...handoff,
      ownerScope: {
        ...ownerScope,
        requestedScopePartRefs: ['communications.attachment-link-references', 'communications.history'],
      },
    });
    const first = yield* fingerprintCommunicationsOwnerHandoff(handoff, crypto);
    // reference sets carry no order, and another owner scope is another handoff
    expect(yield* fingerprintCommunicationsOwnerHandoff(reordered, crypto)).toBe(first);
    const rescoped = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
      ...handoff,
      ownerScope: { ...ownerScope, controllerRef: 'another-controller' },
    });
    expect(yield* fingerprintCommunicationsOwnerHandoff(rescoped, crypto)).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('independently reads the exact Communications outcome and rejects forged and foreign-scope receipts', () =>
  Effect.gen(function* exactCommunicationsOwnerReceipt() {
    const crypto = yield* Crypto.Crypto;
    const tenantId = '75000000-0000-4000-8000-000000000001';
    const legalEntityId = '75000000-0000-4000-8000-000000000002';
    const principalId = '75000000-0000-4000-8000-000000000003';
    const fixture = makeMeasureExecutionFixture(tenantId);
    const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
      ...fixture.handoff,
      ownerScope,
      owningCapability: 'communications.core',
    });
    const context = {
      actionInvocationId: '75000000-0000-4000-8000-000000000004',
      dispatchOriginator: {
        actionInvocationId: '75000000-0000-4000-8000-000000000005',
        compositionRevision: 'a'.repeat(64),
      },
      handoff,
      legalEntityId,
      principalId,
      scope: {
        authMethod: 'session' as const,
        correlationId: 'internal:communications-receipt',
        legalEntityId,
        principalId,
        tenantId,
      },
      tenantId,
    };
    const request = { attempt: 1, measureId: handoff.measureId, taskId: handoff.taskId };
    const outcome = Schema.decodeUnknownSync(OwnerExecutionOutcomeSchema)({
      attempt: 1,
      evidenceRefs: ['communications.core.privacy-measure-handoff:fixture'],
      idempotencyKey: handoff.idempotencyKey,
      includedResourceRefs: [],
      measureId: handoff.measureId,
      occurredAt: fixture.decidedAt,
      outcomeId: 'communications.core.privacy-owner-outcome:fixture:1',
      owningCapability: 'communications.core',
      reason: 'AWAITING_HUMAN_CONFIRMED_OWNER_ACTION',
      recordedAt: fixture.decidedAt,
      remainingResourceRefs: handoff.resourceRefs,
      sourceDecisionRef: handoff.sourceDecisionRef,
      sourceDecisionRevision: 1,
      status: 'RECEIVED',
      taskId: handoff.taskId,
    });
    const receipt = { handoffFingerprint: yield* fingerprintCommunicationsOwnerHandoff(handoff, crypto), outcome };
    let body = JSON.stringify(receipt);
    let status = 200;
    const fakeFetch: typeof globalThis.fetch = (url, init) => {
      const actual = new Request(url, init);
      expect(actual.url).toContain('/reads/privacy-owner-execution-outcome');
      expect(actual.headers.get('authorization')).toBe('Bearer internal-public-owner-fixture');
      return actual
        .json()
        .then((payload: { readonly attempt: number; readonly handoff: { readonly ownerScope: unknown } }) => {
          // the request names the attempt and the exact complete handoff, owner scope included, and can carry no result
          expect(payload.attempt).toBe(1);
          expect(payload.handoff.ownerScope).toEqual(ownerScope);
          return new Response(body, { headers: { 'content-type': 'application/json' }, status });
        });
    };
    const transport = {
      authorization: Redacted.make('Bearer internal-public-owner-fixture'),
      baseUrl: 'https://communications.test',
      compositionRevision: 'a'.repeat(64),
    };
    const read = () =>
      resolveCommunicationsOwnerExecutionReceipt(request, context, transport, crypto).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
    expect((yield* read()).outcome).toEqual(outcome);
    for (const changed of [
      { ...receipt, handoffFingerprint: 'b'.repeat(64) },
      { ...receipt, outcome: { ...outcome, attempt: 2 } },
      { ...receipt, outcome: { ...outcome, includedResourceRefs: ['other:resource'] } },
      { ...receipt, outcome: { ...outcome, sourceDecisionRef: 'other:decision' } },
      { ...receipt, outcome: { ...outcome, owningCapability: 'integration.symmy' } },
      { ...receipt, outcome: { ...outcome, remainingResourceRefs: [] } },
    ]) {
      body = JSON.stringify(changed);
      expect((yield* Effect.flip(read())).code).toBe('privacy_operation_conflict');
    }
    // another owner's handoff is never resolved through this authority
    const foreign = { ...context, handoff: { ...handoff, owningCapability: 'integration.symmy' } };
    body = JSON.stringify(receipt);
    expect(
      (yield* Effect.flip(
        resolveCommunicationsOwnerExecutionReceipt(request, foreign, transport, crypto).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        ),
      )).code,
    ).toBe('privacy_operation_conflict');
    body = 'null';
    expect((yield* Effect.flip(read())).code).toBe('privacy_operation_persistence_unavailable');
    status = 503;
    body = '{}';
    expect((yield* Effect.flip(read())).code).toBe('privacy_operation_persistence_unavailable');
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect(
  'computes the same fingerprint as the Communications owner for the same handoff (cross-owner contract literal)',
  () =>
    Effect.gen(function* crossOwnerFingerprint() {
      const crypto = yield* Crypto.Crypto;
      const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
        contentScopeRefs: ['communications.core.history'],
        controllerObligationRef: null,
        dispositionDecision: 'DELETE',
        expectedEvidenceRefs: ['FICTIONAL-expected-evidence'],
        idempotencyKey: 'FICTIONAL-idempotency-1',
        kind: 'DELETE',
        measureId: 'FICTIONAL-measure-1',
        ownerScope: {
          controllerRef: 'FICTIONAL-controller',
          requestedScopePartRefs: ['communications.history', 'communications.attachment-link-references'],
          requestedScopeRef: 'FICTIONAL-requested-scope',
          trustedLookups: [
            {
              _tag: 'SUBJECT_REFERENCE',
              lookupRef: 'FICTIONAL-lookup-1',
              moduleId: 'party.registry',
              resourceId: 'party-1',
              resourceType: 'party',
            },
          ],
        },
        owningCapability: 'communications.core',
        preconditionRefs: [],
        requestedAt: '2026-11-19T10:00:00.000Z',
        requestedResult: 'erase message metadata',
        resourceRefs: ['communications.core.intent:b', 'communications.core.intent:a'],
        right: 'ERASURE',
        sourceDecisionRef: 'FICTIONAL-decision-1',
        sourceDecisionRevision: 1,
        subjectRef: 'FICTIONAL-subject-1',
        taskId: 'FICTIONAL-task-1',
        tenantId: '00000000-0000-4000-8000-0000000000a1',
      });
      expect(yield* fingerprintCommunicationsOwnerHandoff(handoff, crypto)).toBe(
        'd766e8d812c4955f2c7c853cd14efe8da22fb34ea88abfb67f38e5a1fd1fdf3c',
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

type ReceiptSubject = Option.Option.Value<ReturnType<typeof communicationsReceiptSubject>>;
const receiptAttemptOf = (operation: Extract<ReceiptSubject, { readonly _tag: 'PrivacyDispatch' }>['operation']) =>
  Match.value(operation).pipe(
    Match.tag('CommunicationsReceipt', (receipt) => receipt.attempt ?? null),
    Match.orElse(() => null),
  );
const describeReceiptSource = (
  dispatch: Extract<ReceiptSubject, { readonly _tag: 'PrivacyDispatch' }>,
): Readonly<Record<string, number | string | null>> =>
  Match.value(dispatch.source).pipe(
    Match.tag('Dispatch', (durable) => ({
      attempt: receiptAttemptOf(dispatch.operation),
      dispatchInvocationId: durable.dispatchInvocationId,
      kind: 'durable receipt read',
      operationRequirementKey: dispatch.operationRequirementKey ?? null,
    })),
    Match.tag('Assertion', () => ({ kind: 'carrier continuation' })),
    Match.orElse(() => ({ kind: 'other' })),
  );
/** What a receipt subject asks for, read through its own tags. */
const describeReceiptSubject = (subject: ReceiptSubject) =>
  Match.value(subject).pipe(
    Match.tag('PrivacyDispatch', describeReceiptSource),
    Match.orElse(() => ({ kind: 'other' })),
  );

it('reads the receipt of a pushed continuation through its own durable read, and continues only a take-over carrier', () => {
  const tenantId = '76000000-0000-4000-8000-000000000001';
  const legalEntityId = '76000000-0000-4000-8000-000000000002';
  const principalId = '76000000-0000-4000-8000-000000000003';
  const dispatchInvocationId = '76000000-0000-4000-8000-000000000004';
  const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
    ...makeMeasureExecutionFixture(tenantId).handoff,
    ownerScope,
    owningCapability: 'communications.core',
  });
  const human = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '76000000-0000-4000-8000-000000000005',
    authContextRef: 'FICTIONAL-session',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  });
  const authority = {
    consumerModuleKey: 'communications.core',
    originActionKey: 'privacy.core.dispatch-privacy-measure',
    originCapabilityKey: 'privacy.core.privacy-measure.dispatch',
    producerModuleKey: 'privacy.core',
    subjectResourceType: 'privacy.core.privacy-measure',
    targetAccess: 'delegated-actor',
    topic: 'privacy.measure.dispatched',
    workerKey: 'communications.core.receive-privacy-measure',
  } as const;
  const takeOver = {
    authority,
    claimId: 'FICTIONAL-claim',
    deliveryId: '76000000-0000-4000-8000-000000000008',
    dispatchInvocationId,
    domainEventId: '76000000-0000-4000-8000-000000000009',
    governanceLegalEntityId: legalEntityId,
    handoffHash: 'b'.repeat(64),
    measureId: handoff.measureId,
    messageId: '76000000-0000-4000-8000-000000000010',
    operation: 'PrivacyOutcome',
    principalId,
    requestHash: 'c'.repeat(64),
    sourceMode: 'worker',
    target: {
      access: 'write',
      appId: 'privacy',
      declarationKey: 'privacy.core.owner-execution-outcome.record',
      entrypointKey: 'privacy.core.record-owner-execution-outcome',
      legalEntityScope: 'required',
      moduleId: 'privacy.core',
      schemaVersion: '1',
    },
    taskId: handoff.taskId,
    tenantId,
    workerKey: 'communications.core.receive-privacy-measure',
    workerModuleKey: 'communications.core',
  } as const;
  const continuationOf = (
    overrides: Partial<Record<'dispatchInvocationId' | 'measureId' | 'taskId', string>> = {},
  ): typeof RegisteredGatewayPrivacyDispatchSchema.Encoded => ({
    ...takeOver,
    authority: {
      ...authority,
      continuation: {
        actionKey: 'communications.core.record-owner-execution-evidence',
        topic: 'communications.core.owner-execution-evidence-recorded.v1',
        workerKey: 'communications.core.report-privacy-owner-outcome',
      },
    },
    continuationDeliveryId: '76000000-0000-4000-8000-000000000007',
    sourceMode: 'continuation',
    workerKey: 'communications.core.report-privacy-owner-outcome',
    ...overrides,
  });
  const sealed = (metadata: typeof RegisteredGatewayPrivacyDispatchSchema.Encoded) =>
    readVerifiedGatewayPrivacyDispatch(
      trustVerifiedGatewayPrincipalContext(
        human,
        'a'.repeat(64),
        undefined,
        {
          appId: 'communications',
          buildMarker: 'FICTIONAL-build',
          principalId: '76000000-0000-4000-8000-000000000006',
        },
        undefined,
        undefined,
        Schema.decodeUnknownSync(RegisteredGatewayPrivacyDispatchSchema)(metadata),
      ),
    );
  const context = {
    handoff,
    legalEntityId,
    principalId,
    scope: {
      authMethod: 'session' as const,
      correlationId: 'FICTIONAL-correlation',
      legalEntityId,
      principalId,
      tenantId,
    },
    tenantId,
  };
  const originator = { actionInvocationId: dispatchInvocationId, compositionRevision: 'a'.repeat(64) };
  const request = { attempt: 3, measureId: handoff.measureId, taskId: handoff.taskId };
  /** Which receipt source Privacy chooses: its durable read of the dispatch, the carrier's continuation, or none. */
  const sourceOf = (dispatch?: ReturnType<typeof sealed>) =>
    Option.map(communicationsReceiptSubject(request, context, originator, dispatch), describeReceiptSubject);
  const durable = Option.some({
    attempt: 3,
    dispatchInvocationId,
    kind: 'durable receipt read',
    operationRequirementKey: 'privacy.core.requirement.communications-owner-execution-outcome',
  });
  expect(sourceOf(sealed(continuationOf()))).toEqual(durable);
  // a later pull with no carrier reads the same way; only the take-over carrier is continued
  expect(sourceOf()).toEqual(durable);
  expect(sourceOf(sealed(takeOver))).toEqual(Option.some({ kind: 'carrier continuation' }));
  // a continuation of another dispatch, measure or task is never read for this one
  for (const overrides of [
    { dispatchInvocationId: '76000000-0000-4000-8000-000000000011' },
    { measureId: 'FICTIONAL-another-measure' },
    { taskId: 'FICTIONAL-another-task' },
  ]) {
    expect(Option.isNone(sourceOf(sealed(continuationOf(overrides))))).toBe(true);
  }
});
