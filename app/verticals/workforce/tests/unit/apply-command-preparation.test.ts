import { ActionPermissionCheckError, ActionPermissionDenied } from '@app/core-runtime';
import { updateEmployeeAction } from '../../src/actions/update-employee.action.ts';
import { prepareWorkforceCommand } from '../../src/services/persistence.service.ts';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { WorkforceCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { workforceRegistration } from '../../vertical.registration.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:workforce-command',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload = Schema.decodeSync(WorkforceCommandPayloadSchema)({
  command: {
    _tag: 'CreateEmployee',
    active: true,
    department: 'Provoz',
    email: 'regression@example.test',
    fullName: 'Regresní test',
    id: '50000000-0000-4000-8000-000000000001',
    role: 'SALES_REP',
  },
  expectedRevision: 0,
});

const commands = [
  payload,
  Schema.decodeSync(WorkforceCommandPayloadSchema)({
    command: { _tag: 'UpdateEmployee', id: '50000000-0000-4000-8000-000000000001', patch: { department: 'Provoz' } },
    expectedRevision: 1,
  }),
];
for (const [index, command] of commands.entries()) {
  for (const access of ['denied', 'unavailable'] as const) {
    it.effect(`registered workforce command ${index} refuses ${access} before owner SQL`, () =>
      Effect.scoped(
        Effect.gen(function* refusesBeforeSql() {
          const harness = yield* makeActionTestHarness({ access, ownerRegistration: workforceRegistration });
          const request = {
            payload: Schema.encodeSync(WorkforceCommandPayloadSchema)(command),
            principal,
            transport: { correlationId: 'workforce-command', idempotencyKey: `workforce-${index}-${access}` },
          };
          const failure = yield* (
            index === 0
              ? harness.runtime.runAction({ ...request, registration: applyCommandAction })
              : harness.runtime.runAction({ ...request, registration: updateEmployeeAction })
          ).pipe(Effect.flip);
          expect(Schema.is(access === 'denied' ? ActionPermissionDenied : ActionPermissionCheckError)(failure)).toBe(
            true,
          );
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        }),
      ),
    );
  }
}
it.effect('owner preparation does not re-decide run after Core admits an approval', () =>
  prepareWorkforceCommand(payload.command, { ...principal, correlationId: 'approved-command' }),
);
