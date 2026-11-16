import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkforceCommandPayloadSchema, ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { workforceRegistration } from '../../vertical.registration.ts';
import { updateEmployeeAction } from '../../src/actions/update-employee.action.ts';
import { recordsRead } from '../../src/api/records.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const allowedId = '50000000-0000-4000-8000-000000000001';
const otherId = '50000000-0000-4000-8000-000000000002';
const now = '2026-11-02T00:00:00.000Z';
const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:record-write',
  authMethod: 'session' as const,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId,
  tenantId,
};
const result = Schema.decodeSync(ApplyCommandResultSchema)({
  employees: [
    {
      active: true,
      createdAt: now,
      department: 'Updated',
      email: 'owner@example.test',
      fullName: 'Owner',
      id: allowedId,
      role: 'SUPPORT',
      updatedAt: now,
    },
  ],
  revision: 2,
});
const cases = [
  {
    command: { _tag: 'UpdateEmployee', id: allowedId, patch: { department: 'Updated' } },
    registration: updateEmployeeAction,
  },
] as const;
for (const { command, registration } of cases) {
  it.effect(`${registration.descriptor.actionKey} authorizes exactly its command record in the trusted scope`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const payload = Schema.decodeSync(WorkforceCommandPayloadSchema)({ command, expectedRevision: 1 });
        const granted = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
        const denied = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } });
        const checkedCarriers = new Set<string>();
        const accessDecision: typeof granted.bound = {
          ...granted.bound,
          decide: (input, transaction) => {
            const declaration = input.carrier.accessDeclaration;
            if (declaration?.key === registration.descriptor.accessDeclaration?.key) {
              expect(declaration).toEqual(registration.descriptor.accessDeclaration);
            } else {
              expect(declaration).toEqual(recordsRead.descriptor.accessDeclaration);
            }
            checkedCarriers.add(declaration?.key ?? 'missing');
            expect(input.mode).toBe('run');
            expect(input.target?.moduleKey).toBe(registration.descriptor.owningModuleKey);
            expect(input.scope.tenantId).toBe(tenantId);
            expect(input.scope.legalEntityId).toBe(principal.legalEntityId);
            return (input.target?.recordKey === allowedId ? granted : denied).bound.decide(input, transaction);
          },
        };
        let writes = 0;
        const harness = yield* makeActionTestHarness({
          accessDecision,
          ownerRegistration: workforceRegistration,
          services: [
            bindActionTestServices(registration, {
              apply: () =>
                Effect.sync(() => {
                  writes += 1;
                  return result;
                }),
              loadRecords: () => Effect.die('A write must not call the records read'),
            }),
          ],
        });
        const request = {
          payload: Schema.encodeSync(WorkforceCommandPayloadSchema)(payload),
          principal,
          registration,
          transport: { correlationId: 'record-write', idempotencyKey: registration.descriptor.actionKey },
        };
        const success = yield* harness.runtime.runAction(request);
        expect(success.revision).toBe(2);
        expect(checkedCarriers).toEqual(
          new Set([registration.descriptor.accessDeclaration?.key, recordsRead.descriptor.accessDeclaration?.key]),
        );
        expect(writes).toBe(1);
        expect(harness.snapshot().committed).toHaveLength(1);
        const encoded = Schema.encodeSync(WorkforceCommandPayloadSchema)(payload);
        const other = { ...encoded, command: { ...command, id: otherId } };
        const failure = yield* harness.runtime
          .runAction({
            ...request,
            payload: other,
            transport: { correlationId: 'record-denied', idempotencyKey: `${registration.descriptor.actionKey}-other` },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(writes).toBe(1);
        expect(harness.snapshot().committed).toHaveLength(1);
      }),
    ),
  );
  it.effect(`${registration.descriptor.actionKey} requires independent governing Read authority before writing`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const granted = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
        const denied = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } });
        let readChecks = 0;
        const harness = yield* makeActionTestHarness({
          accessDecision: {
            ...granted.bound,
            decide: (input, transaction) => {
              expect(input.mode).toBe('run');
              expect(input.target?.recordKey).toBe(allowedId);
              if (input.carrier.accessDeclaration?.key === recordsRead.descriptor.accessDeclaration?.key) {
                expect(input.carrier.accessDeclaration).toEqual(recordsRead.descriptor.accessDeclaration);
                readChecks += 1;
                return denied.bound.decide(input, transaction);
              }
              expect(input.carrier.accessDeclaration).toEqual(registration.descriptor.accessDeclaration);
              return granted.bound.decide(input, transaction);
            },
          },
          ownerRegistration: workforceRegistration,
          services: [
            bindActionTestServices(registration, {
              apply: () => Effect.die('Denied governing Read must prevent the write'),
              loadRecords: () => Effect.die('Authorization must not execute the governing Read'),
            }),
          ],
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration,
            transport: {
              correlationId: 'read-denied',
              idempotencyKey: `${registration.descriptor.actionKey}-read-denied`,
            },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(readChecks).toBeGreaterThan(0);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
  it.effect(`${registration.descriptor.actionKey} never treats approval-only authority as a write`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({
          access: 'needs_approval',
          ownerRegistration: workforceRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration,
            transport: { correlationId: 'approval-only', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect('code' in failure && failure.code).toBe('action_approval_required');
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
  it.effect(`the former scope-wide dispatcher cannot bypass ${registration.descriptor.actionKey}`, () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: workforceRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command, expectedRevision: 1 },
            principal,
            registration: applyCommandAction,
            transport: { correlationId: 'no-dispatch-bypass', idempotencyKey: registration.descriptor.actionKey },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPayloadValidationError')).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
}
