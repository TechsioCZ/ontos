import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrivacyMeasureHandoffSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import { dispatchPrivacyMeasureAction } from '../../src/actions/dispatch-privacy-measure.action.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-repository.ts';
import type { PrivacyOperationRepositoryService } from '../../src/persistence/privacy-operation-repository.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000003',
  authContextRef: 'better-auth-session:privacy-dispatch-unit',
  authMethod: 'session',
  legalEntityId,
  principalId: '40000000-0000-4000-8000-000000000004',
  tenantId,
} as const;
const handoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: ['party.registry.counterparty.lifecycle'],
  controllerObligationRef: 'TEST:obligation',
  dispositionDecision: 'RESTRICT',
  expectedEvidenceRefs: ['TEST:receipt'],
  idempotencyKey: 'business-handoff:1',
  kind: 'RESTRICT',
  measureId: 'measure:1',
  owningCapability: 'party.registry',
  preconditionRefs: ['TEST:decision'],
  requestedAt: '2026-10-23T09:00:00.000Z',
  requestedResult: 'RESTRICTED',
  resourceRefs: ['TEST:counterparty'],
  right: null,
  sourceDecisionRef: 'TEST:decision',
  sourceDecisionRevision: 1,
  subjectRef: 'TEST:subject',
  taskId: 'TEST:task',
  tenantId,
});
const request = (idempotencyKey: string) => ({
  payload: { handoff },
  principal,
  registration: dispatchPrivacyMeasureAction,
  transport: { correlationId: 'privacy-dispatch-unit', idempotencyKey },
});
const harnessFor = (admitMeasureDispatch: PrivacyOperationRepositoryService['admitMeasureDispatch']) =>
  makeActionTestHarness({
    actionPermission: 'allowed',
    legalEntityPermission: 'allowed',
    services: [bindActionTestServices(dispatchPrivacyMeasureAction, { admitMeasureDispatch })],
    tenantPermission: 'allowed',
  });

it.effect('registered dispatch emits one linked event and targeted message only for a new owner insertion', () =>
  Effect.gen(function* insertedDispatch() {
    let calls = 0;
    const harness = yield* harnessFor((tenant, legalEntity, invocation, input) =>
      Effect.sync(() => {
        expect([tenant, legalEntity]).toEqual([tenantId, legalEntityId]);
        expect(invocation.length).toBeGreaterThan(0);
        expect(input).toEqual(handoff);
        calls += 1;
        return { created: calls === 1, handoff };
      }),
    );
    expect(yield* harness.runtime.runAction(request('transport:1'))).toEqual(handoff);
    expect(yield* harness.runtime.runAction(request('transport:2'))).toEqual(handoff);
    const { committed } = harness.snapshot();
    expect(committed).toHaveLength(2);
    expect(committed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages[0]).toMatchObject({
      completion: { consumerModuleKey: 'party.registry', originalRevision: 'a'.repeat(64) },
      message: { payloadJson: { handoff }, producerModuleKey: 'privacy.core', topic: 'privacy.measure.dispatched' },
    });
    expect(committed[1]?.evidence.domainEvents).toEqual([]);
    expect(committed[1]?.evidence.outboxMessages).toEqual([]);
    expect(calls).toBe(2);
    const replay = yield* Effect.result(harness.runtime.runAction(request('transport:1')));
    expect(replay).toMatchObject({ failure: { _tag: 'ActionAlreadyCommitted' } });
    expect(calls).toBe(2);
    expect(harness.snapshot().committed).toHaveLength(2);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('registered dispatch commits no success evidence when the owner rejects a business-key conflict', () =>
  Effect.gen(function* conflictingDispatch() {
    const harness = yield* harnessFor(() =>
      Effect.fail(
        new PrivacyOperationPersistenceError({
          code: 'privacy_operation_conflict',
          reason: 'Privacy Measure idempotency conflict',
        }),
      ),
    );
    const result = yield* Effect.result(harness.runtime.runAction(request('conflicting')));
    expect(result).toMatchObject({ failure: { code: 'privacy_operation_conflict' } });
    expect(harness.snapshot().committed).toEqual([]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('registered dispatch validates trusted Tenant before asking the owner to admit work', () =>
  Effect.gen(function* invalidTenant() {
    const harness = yield* harnessFor(() => Effect.die('Invalid Tenant must not reach owner persistence'));
    const result = yield* Effect.result(
      harness.runtime.runAction({
        ...request('foreign-tenant'),
        payload: { handoff: { ...handoff, tenantId: '90000000-0000-4000-8000-000000000009' } },
      }),
    );
    expect(result).toMatchObject({ failure: { code: 'privacy_action_rejected' } });
    expect(harness.snapshot().committed).toEqual([]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
