import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema, RecordKeySchema, TenantIdSchema } from '../../src/access/ids.ts';
import { defineActionGoverningRead, getActionGoverningRead } from '../../src/actions/governing-read.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeOwnerApplicationCompositionFixture } from '../../src/testing/module-contract.ts';
import { getVerticalRuntimeReads } from '../../src/modules/runtime-registration.ts';
import { accessDecisionUnavailable } from '../../src/access/decision/errors.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import { makeCanonicalActionTestAccessGate } from '../../src/testing/access-gate.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { cell, makeAuthority, makeCheck } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';
import { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../../src/modules/module-dependency-contracts.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { actionFor, ownerKey, principal, readFor } from '../support/action-command-v2.ts';

const noTransactions = () => 0;

it('retains the original registered Read and its independent sensitive field declarations', () => {
  const read = readFor();
  const reference = defineActionGoverningRead(read);
  expect(Object.isFrozen(reference)).toBe(true);
  expect(Object.keys(reference)).toEqual([]);
  expect(getActionGoverningRead(reference)).toBe(read);
  expect(getActionGoverningRead(reference)?.descriptor.accessFieldGroups?.[0]?.kind).toBe('field_read');
  const copyTarget = {};
  const copiedRead = Object.assign(copyTarget, read);
  expect(() => defineActionGoverningRead(copiedRead)).toThrow();
  expect(() => defineActionGoverningRead(readFor(ownerKey, false))).toThrow();
  expect(() => actionFor(readFor('demo.other-owner'))).toThrow();
});

for (const registered of [true, false]) {
  it.effect(
    `validates actual governing Read membership against the admitted owner catalog, registered=${registered}`,
    () =>
      Effect.gen(function* governingReadMembership() {
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({
          actions: [action],
          moduleId: ownerKey,
          reads: registered ? [read] : [],
        });
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          applicationComposition: owner.applicationComposition,
          expectedDeployment: owner.expectedDeployment,
          ownerRegistration: owner.ownerRegistration,
        });
        const result = yield* Effect.result(
          harness.runtime.runAction({
            payload: { ids: [RecordKeySchema.make('first'), RecordKeySchema.make('second')] },
            principal,
            registration: action,
            transport: { correlationId: 'governing-read', idempotencyKey: 'governing-read' },
          }),
        );
        if (registered) {
          expect(result).toMatchObject({ success: 2 });
          expect(harness.snapshot().committed).toHaveLength(1);
        } else {
          expect(result).toMatchObject({ failure: { _tag: 'ActionTransactionError' } });
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().transactionCount).toBe(0);
        }
      }),
  );
}

for (const runtime of ['native-action', 'unavailable'] as const) {
  it.effect(
    `owner fixtures retain real requirements and admit only the implemented native runtime capability, ${runtime}`,
    () =>
      Effect.gen(function* nativeRuntimeCapability() {
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({
          actions: [action],
          moduleId: ownerKey,
          reads: [read],
          requirements: {
            coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
            intrinsic: [],
            operations: [],
            schemaVersion: '1',
          },
        });
        const built = yield* Effect.result(
          makeOwnerApplicationCompositionFixture({
            ownerRegistration: owner.ownerRegistration,
            runtime,
          }),
        );
        if (runtime === 'unavailable') {
          expect(built).toMatchObject({ failure: { _tag: 'ActiveApplicationCompositionUnavailableError' } });
          return;
        }
        const fixture = yield* Effect.fromResult(built);
        expect(fixture.snapshot.composition.shell.coreCapabilities).toEqual([
          ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
        ]);
        const harness = yield* makeActionTestHarness({ access: 'allowed', ...fixture });
        expect(
          yield* harness.runtime.runAction({
            payload: { ids: [RecordKeySchema.make('first'), RecordKeySchema.make('second')] },
            principal,
            registration: action,
            transport: { correlationId: 'native-capability', idempotencyKey: 'native-capability' },
          }),
        ).toBe(2);
        expect(harness.snapshot().committed).toHaveLength(1);
      }),
  );
}

it.effect('never turns an unknown owner-required capability into a supported runtime claim', () =>
  Effect.gen(function* unavailableRuntimeCapability() {
    const action = actionFor();
    const owner = makeTestOperationOwner({
      actions: [action],
      moduleId: ownerKey,
      requirements: {
        coreCapabilities: [{ id: 'ontos.not-implemented', version: '1' }],
        intrinsic: [],
        operations: [],
        schemaVersion: '1',
      },
    });
    expect(
      yield* Effect.result(
        makeOwnerApplicationCompositionFixture({
          ownerRegistration: owner.ownerRegistration,
        }),
      ),
    ).toMatchObject({ failure: { _tag: 'ActiveApplicationCompositionUnavailableError' } });
  }),
);

const nativeGoverningGate = (
  restriction: 'allowed' | 'missing-middle-record' | 'missing-read-field' | 'unavailable',
  transactionCount: () => number,
) =>
  Effect.gen(function* canonicalGoverningGateFixture() {
    const first = RecordKeySchema.make('first');
    const second = RecordKeySchema.make('second');
    const spec: AuthoritySpec = {
      cells: [
        cell({ capability: `${ownerKey}.record.change` }),
        cell({
          capability: `${ownerKey}.record.read`,
          selector: {
            _tag: 'targets',
            recordKeys: restriction === 'missing-middle-record' ? [first] : [first, second],
          },
        }),
        ...(restriction === 'missing-read-field' ? [] : [cell({ capability: `${ownerKey}.record.read-salary` })]),
      ],
      legalEntityScope: {
        _tag: 'LegalEntity',
        legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
        tenantId: TenantIdSchema.make(principal.tenantId),
      },
    };
    const authority = makeAuthority(spec).port;
    const check = makeCheck({ authority: spec }).port;
    const intent = { authorityFor: () => authority, joined: () => ({ authorityFor: () => authority }) };
    const ports = {
      candidates: { listCandidateIds: () => Effect.succeed([]) },
      check: {
        checkBulk: Effect.fn('GoverningReadFixture.remote')(function* remoteCheck(
          items: Parameters<typeof check.checkBulk>[0],
        ) {
          expect(transactionCount()).toBe(0);
          yield* refuseInsideDatabaseTransaction('spicedb', 'governing-read-fixture');
          return yield* check.checkBulk(items);
        }),
      },
      currentness: { read: () => Effect.succeed([{ revision: 1, scopeId: 'governing-read-fixture-revision' }]) },
      decisionLog: { record: () => Effect.void },
      intent,
      principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
    };
    const gate = yield* makeCanonicalActionTestAccessGate(ports);
    const questions: GateInput[] = [];
    return {
      bound: {
        ...gate,
        prepare: (question: GateInput) => {
          questions.push(question);
          if (restriction === 'unavailable' && question.carrier.accessDeclaration?.kind === 'read') {
            return Effect.fail(accessDecisionUnavailable('The actual record read is unavailable'));
          }
          return gate.prepare === undefined
            ? Effect.fail(accessDecisionUnavailable('Canonical preparation is required'))
            : gate.prepare(question);
        },
      },
      questions,
    };
  });

for (const restriction of ['allowed', 'missing-middle-record', 'missing-read-field', 'unavailable'] as const) {
  it.effect(
    `the genuine registered-owner lifecycle keeps every governing record and field restriction, ${restriction}`,
    () =>
      Effect.gen(function* nativeGoverningReadLifecycle() {
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
        let transactionCount = noTransactions;
        const gate = yield* nativeGoverningGate(restriction, () => transactionCount());
        const harness = yield* makeActionTestHarness({
          accessDecision: gate.bound,
          ownerRegistration: owner.ownerRegistration,
        });
        transactionCount = () => harness.snapshot().transactionCount;
        const result = yield* Effect.result(
          harness.runtime.runAction({
            payload: { ids: [RecordKeySchema.make('first'), RecordKeySchema.make('second')] },
            principal,
            registration: action,
            transport: { correlationId: `native-read-${restriction}`, idempotencyKey: `native-read-${restriction}` },
          }),
        );
        if (restriction === 'allowed') {
          expect(result).toMatchObject({ success: 2 });
          expect(harness.snapshot().committed).toHaveLength(1);
          for (const key of [read.descriptor.accessDeclaration?.key, read.descriptor.accessFieldGroups?.[0]?.key]) {
            const questions = gate.questions.filter((question) => question.carrier.accessDeclaration?.key === key);
            expect(questions.map((question) => question.target?.recordKey)).toEqual(['first', 'second']);
            expect(questions.every((question) => question.mode === 'run')).toBe(true);
          }
        } else {
          expect(result).toMatchObject({
            failure: { _tag: restriction === 'unavailable' ? 'ActionPermissionCheckError' : 'ActionPermissionDenied' },
          });
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().permissionDenials).toHaveLength(restriction === 'unavailable' ? 0 : 1);
        }
      }),
  );
}

it.effect(
  'the public owner fixture derives a validated catalog while retaining the original governing Read identity',
  () =>
    Effect.gen(function* publicOriginalOwnerFixture() {
      const read = readFor();
      const action = actionFor(read);
      const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
      const fixture = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: owner.ownerRegistration });
      expect(fixture.ownerRegistration).toBe(owner.ownerRegistration);
      expect(getVerticalRuntimeReads(fixture.ownerRegistration)).toEqual([read]);
      expect(getVerticalRuntimeReads(fixture.ownerRegistration)[0]).toBe(
        getActionGoverningRead(action.descriptor.accessGoverningRead),
      );
      expect(fixture.snapshot.composition.modules[0]?.moduleId).toBe(ownerKey);
      const harness = yield* makeActionTestHarness({ access: 'allowed', ...fixture });
      expect(
        yield* harness.runtime.runAction({
          payload: { ids: [RecordKeySchema.make('first'), RecordKeySchema.make('second')] },
          principal,
          registration: action,
          transport: { correlationId: 'public-owner-fixture', idempotencyKey: 'public-owner-fixture' },
        }),
      ).toBe(2);
    }),
);

for (const registered of [true, false]) {
  it.effect(
    `an owner-only native Action harness derives composition but never invents governing Read membership, registered=${registered}`,
    () =>
      Effect.gen(function* defaultOwnerComposition() {
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({
          actions: [action],
          moduleId: ownerKey,
          reads: registered ? [read] : [],
        });
        const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: owner.ownerRegistration });
        const result = yield* Effect.result(
          harness.runtime.runAction({
            payload: { ids: [RecordKeySchema.make('first'), RecordKeySchema.make('second')] },
            principal,
            registration: action,
            transport: { correlationId: 'default-owner-fixture', idempotencyKey: 'default-owner-fixture' },
          }),
        );
        if (registered) {
          expect(result).toMatchObject({ success: 2 });
          expect(harness.snapshot().committed).toHaveLength(1);
        } else {
          expect(result).toMatchObject({ failure: { _tag: 'ActionTransactionError' } });
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().transactionCount).toBe(0);
        }
      }),
  );
}
