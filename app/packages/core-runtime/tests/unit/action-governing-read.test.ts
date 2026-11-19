import { Effect, Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActionMandateDispatch, MandatePrepared } from '../../src/access/approvals/action-mandate-dispatch.ts';
import { freezeActionCommandV2, resolveActionCommandV2 } from '../../src/access/approvals/action-command-v2.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
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

/**
 * The canonical gate of the native governing-Read lifecycle whose record-field read can be revoked between two
 * requests while the Action's own run, propose and approve grants stay.
 */
const revocableGoverningGate = Effect.fn('GoverningReadFixture.revocable')(function* revocableGoverningGate() {
  const legalEntityScope = {
    _tag: 'LegalEntity' as const,
    legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
    tenantId: TenantIdSchema.make(principal.tenantId),
  };
  const gateFor = (readField: boolean) => {
    const spec: AuthoritySpec = {
      cells: [
        ...(['run', 'propose', 'approve'] as const).map((mode) =>
          cell({ capability: `${ownerKey}.record.change`, mode }),
        ),
        cell({ capability: `${ownerKey}.record.read` }),
        ...(readField ? [cell({ capability: `${ownerKey}.record.read-salary` })] : []),
      ],
      legalEntityScope,
    };
    const authority = makeAuthority(spec).port;
    return makeCanonicalActionTestAccessGate({
      candidates: { listCandidateIds: () => Effect.succeed([]) },
      check: makeCheck({ authority: spec }).port,
      currentness: { read: () => Effect.succeed([{ revision: 1, scopeId: 'governing-read-replay-revision' }]) },
      decisionLog: { record: () => Effect.void },
      intent: { authorityFor: () => authority, joined: () => ({ authorityFor: () => authority }) },
      principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
    });
  };
  const granted = yield* gateFor(true);
  const revoked = yield* gateFor(false);
  let readRevoked = false;
  const current = () => (readRevoked ? revoked : granted);
  const bound: BoundAccessGate = {
    ...granted,
    decide: (question, transaction) => current().decide(question, transaction),
    list: (question, transaction) => current().list(question, transaction),
    prepare: (question) => {
      const { prepare } = current();
      return prepare === undefined ? Effect.die('The canonical gate prepares its decisions') : prepare(question);
    },
  };
  return {
    bound,
    revokeRead: () =>
      Effect.sync(() => {
        readRevoked = true;
      }),
  };
});

/** An approvals adapter whose one mandate carries exactly the committed request's command. */
const mandateFor = (action: ReturnType<typeof actionFor>, ids: readonly string[]): ActionMandateDispatch => ({
  claim: () => Effect.void,
  commit: () => Effect.void,
  loadParkedProposal: () => Effect.succeed(Option.none()),
  parkProposal: () => Effect.die('A replay never parks a proposal'),
  prepare: (input) =>
    resolveActionCommandV2({
      payload: { ids: ids.map((id) => RecordKeySchema.make(id)) },
      registration: action,
      scope: input.scope,
    }).pipe(
      Effect.map(
        (command) =>
          ({
            approverId: input.scope.principalId,
            command: { capabilityKey: CapabilityKeySchema.make(input.capabilityKey), payload: command },
            commandDigest: Result.getOrThrow(freezeActionCommandV2(command)),
            mandateId: input.mandateId,
            proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-0000000000b2'),
            scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-0000000000a1'),
          }) satisfies MandatePrepared,
      ),
    ),
});

const replayMandateId = '00000000-0000-4000-8000-000000000123';

/** The transport of a same-key retry: an ordinary run, an explicit propose intent, or a mandate execution. */
const retryTransport = (retry: 'run' | 'propose' | 'approve', correlationId: string, idempotencyKey: string) => {
  if (retry === 'propose') {
    return { correlationId, idempotencyKey, intent: 'propose' as const };
  }
  if (retry === 'approve') {
    return { correlationId, idempotencyKey, mandateId: replayMandateId };
  }
  return { correlationId, idempotencyKey };
};

for (const retry of ['run', 'propose', 'approve'] as const) {
  for (const readRevoked of [false, true]) {
    it.effect(
      `a same-key ${retry} retry of a committed run answers its saved result only while the governing Read is granted, revoked=${readRevoked}`,
      () =>
        Effect.gen(function* governingReadReplay() {
          const read = readFor();
          const action = actionFor(read);
          const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
          const gate = yield* revocableGoverningGate();
          const ids = ['first', 'second'];
          const harness = yield* makeActionTestHarness({
            accessDecision: gate.bound,
            mandateDispatch: mandateFor(action, ids),
            ownerRegistration: owner.ownerRegistration,
          });
          const key = `governing-replay-${retry}-${readRevoked}`;
          const committed = yield* harness.runtime.runAction({
            payload: { ids: ids.map((id) => RecordKeySchema.make(id)) },
            principal,
            registration: action,
            savedReply: 'answer',
            successContract: 'result-or-proposal',
            transport: { correlationId: `${key}-run`, idempotencyKey: key },
          });
          expect(committed).toBe(2);
          if (readRevoked) {
            yield* gate.revokeRead();
          }
          const replayed = yield* Effect.result(
            harness.runtime.runAction({
              payload: retry === 'approve' ? undefined : { ids: ids.map((id) => RecordKeySchema.make(id)) },
              principal,
              registration: action,
              savedReply: 'answer',
              successContract: 'result-or-proposal',
              transport: retryTransport(retry, `${key}-retry`, key),
            }),
          );
          if (retry === 'approve') {
            // A mandate executes its own invocation, never the run's saved reply: it gets every check of a first run.
            expect(replayed).toMatchObject(
              readRevoked ? { failure: { _tag: 'ActionPermissionDenied' } } : { success: 2 },
            );
            expect(harness.snapshot().committed).toHaveLength(readRevoked ? 1 : 2);
            return;
          }
          // A revoked governing Read refuses the replay exactly as it refuses an ordinary retry: no saved result.
          expect(replayed).toMatchObject(
            readRevoked ? { failure: { _tag: 'ActionAlreadyCommitted' } } : { success: 2 },
          );
          expect(harness.snapshot().committed).toHaveLength(1);
        }),
    );
  }
}

for (const ids of [['first'], ['second', 'first'], ['first', 'second', 'third']]) {
  it.effect(
    `a same-key retry whose target set differs in shape never gets the saved result, ids=${ids.join(',')}`,
    () =>
      Effect.gen(function* otherTargetSetRetry() {
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
        const gate = yield* revocableGoverningGate();
        const harness = yield* makeActionTestHarness({
          accessDecision: gate.bound,
          ownerRegistration: owner.ownerRegistration,
        });
        const key = `governing-replay-shape-${ids.join('-')}`;
        const request = (recordIds: readonly string[], correlationId: string) => ({
          payload: { ids: recordIds.map((id) => RecordKeySchema.make(id)) },
          principal,
          registration: action,
          savedReply: 'answer' as const,
          transport: { correlationId, idempotencyKey: key },
        });
        expect(yield* harness.runtime.runAction(request(['first', 'second'], `${key}-run`))).toBe(2);
        const otherTargets = yield* Effect.result(harness.runtime.runAction(request(ids, `${key}-retry`)));
        expect(Result.isFailure(otherTargets)).toBe(true);
        expect(otherTargets).not.toMatchObject({ failure: { _tag: 'ActionAlreadyCommitted' } });
        expect(harness.snapshot().committed).toHaveLength(1);
      }),
  );
}
