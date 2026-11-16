import { eq } from 'drizzle-orm';
import { integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { Effect, Exit, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { ActionAlreadyCommitted, ActionTransactionError } from '../../src/actions/errors.ts';
import { defineAction } from '../../src/actions/definition.ts';
import type { ActionServiceFactory, ActionServicePreflight } from '../../src/actions/definition.ts';
import { createActionTransactionErrorWithCause } from '../../src/actions/transaction-error.ts';
import { OperationContextUnavailable } from '../../src/operations/errors.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import type { ActionTestPreparationRead } from '../../src/testing/actions.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

const table = pgTable('action_preparation_fixture', {
  tenantId: uuid('tenant_id').notNull(),
  value: integer('value').notNull(),
});
const statement =
  'select "value" from "action_preparation_fixture" where "action_preparation_fixture"."tenant_id" = $1';
const writeStatement =
  'update "action_preparation_fixture" set "value" = $1 where "action_preparation_fixture"."tenant_id" = $2';
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:action-preparation-reads',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;
const ownerKey = 'test.preparation-reads';
const payloadSchema = Schema.Struct({});
const PreparationModeSchema = Schema.Literals(['read', 'write', 'writer-read']);
type PreparationMode = typeof PreparationModeSchema.Type;
interface Services {
  readonly value: number;
}
const readValue = (transaction: ScopedTransactionExecutor, tenantId: string) =>
  transaction
    .select({ value: table.value })
    .from(table)
    .where(eq(table.tenantId, tenantId))
    .pipe(Effect.map((rows) => rows[0]?.value ?? -1));
const snapshotFailure = (cause: Effect.Error<ReturnType<typeof readValue>>) =>
  createActionTransactionErrorWithCause(
    {
      code: 'action_transaction_failed',
      reason: 'The fixture preparation snapshot could not be read',
    },
    cause,
  );
const factoryFailure = (cause: Effect.Error<ReturnType<typeof readValue>>) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'The fixture writer service could not be acquired',
    }),
    'cause',
    { value: cause },
  );
const preparedFactory =
  (input: {
    readonly mode: PreparationMode;
    readonly tenantId: string;
    readonly value: number;
  }): ActionServiceFactory<Services> =>
  (transaction) =>
    input.mode === 'writer-read'
      ? readValue(transaction, input.tenantId).pipe(
          Effect.map((value) => ({ value })),
          Effect.mapError(factoryFailure),
        )
      : Effect.succeed({ value: input.value });
const preparationFor =
  (mode: PreparationMode): ActionServicePreflight<typeof payloadSchema.Type, Services, never> =>
  (_payload, context) =>
    context
      .transaction((transaction) => {
        const snapshot =
          mode === 'write'
            ? transaction
                .update(table)
                .set({ value: 9 })
                .where(eq(table.tenantId, context.scope.tenantId))
                .pipe(Effect.as(9))
            : readValue(transaction, context.scope.tenantId);
        return snapshot.pipe(Effect.mapError(snapshotFailure));
      })
      .pipe(Effect.map((value) => preparedFactory({ mode, tenantId: context.scope.tenantId, value })));

const actionFor = (mode: 'read' | 'write' | 'writer-read' = 'read') =>
  defineAction(
    {
      accessDeclaration: {
        key: `${ownerKey}.record.change`,
        kind: 'action',
        modes: ['run'],
        placement: { group: 'records', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${ownerKey}.evidence.v1` },
      actionKey: `${ownerKey}.change`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: `${ownerKey}.change`,
        moduleKey: ownerKey,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: ownerKey,
      payloadSchema,
      policies: [],
      resultSchema: Schema.Number,
      schemaVersion: '1',
    },
    (_payload, context) => Effect.succeed(context.services.value),
    (): Effect.Effect<{ readonly value: number }> => Effect.die('Original preparation must supply the factory'),
    { prepareServices: preparationFor(mode) },
  );
const requestFor = (registration: ReturnType<typeof actionFor>) => ({
  payload: {},
  principal,
  registration,
  transport: { correlationId: 'preparation-reads', idempotencyKey: 'preparation-reads' },
});
const harnessFor = (
  action: ReturnType<typeof actionFor>,
  execute?: (query: ActionTestPreparationRead) => Effect.Effect<readonly object[], SqlError>,
  sql = statement,
) => {
  const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey });
  return makeActionTestHarness({
    access: 'allowed',
    ownerRegistration: owner.ownerRegistration,
    preparationReads: execute === undefined ? [] : [{ execute, sql }],
  });
};

it.effect(
  'runs the genuine original preflight SELECT, scoped native mapping, prepared factory and registered handler',
  () =>
    Effect.gen(function* originalFactoryWithSnapshot() {
      const action = actionFor();
      let queries = 0;
      const harness = yield* harnessFor(action, (query) =>
        Effect.sync(() => {
          queries += 1;
          expect(query.sql).toBe(statement);
          expect(query.params).toEqual([principal.tenantId]);
          expect(query.scope).toEqual({ legalEntityId: '', tenantId: principal.tenantId });
          expect(Object.isFrozen(query)).toBe(true);
          return [{ value: 7 }];
        }),
      );
      expect(yield* harness.runtime.runAction(requestFor(action))).toBe(7);
      expect(queries).toBe(1);
      expect(harness.snapshot().transactionCount).toBe(2);
      expect(harness.snapshot().preparationQueries).toHaveLength(1);
      expect(harness.snapshot().committed).toHaveLength(1);
      expect(
        Schema.is(ActionAlreadyCommitted)(yield* harness.runtime.runAction(requestFor(action)).pipe(Effect.flip)),
      ).toBe(true);
      expect(queries).toBe(1);
    }),
);

it.effect('keeps unlisted preparation SELECTs closed without an empty-row fallback', () =>
  Effect.gen(function* unlistedOwnerRead() {
    const action = actionFor();
    const harness = yield* harnessFor(action);
    const failure = yield* harness.runtime.runAction(requestFor(action)).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ActionHandlerExecutionError')).toBe(true);
    expect(harness.snapshot().preparationQueries.map(({ sql }) => sql)).toEqual([statement]);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('never permits a scripted write in a preparation snapshot', () =>
  Effect.gen(function* noPreparationWritePermit() {
    const action = actionFor('write');
    let scripts = 0;
    const harness = yield* harnessFor(
      action,
      () =>
        Effect.sync(() => {
          scripts += 1;
          return [];
        }),
      writeStatement,
    );
    expect(Exit.isFailure(yield* Effect.exit(harness.runtime.runAction(requestFor(action))))).toBe(true);
    expect(scripts).toBe(0);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('does not lend the preparation SELECT allowance to the actual owner writer', () =>
  Effect.gen(function* noWriterReadAllowance() {
    const action = actionFor('writer-read');
    let scripts = 0;
    const harness = yield* harnessFor(action, () =>
      Effect.sync(() => {
        scripts += 1;
        return [{ value: 7 }];
      }),
    );
    expect(Exit.isFailure(yield* Effect.exit(harness.runtime.runAction(requestFor(action))))).toBe(true);
    expect(scripts).toBe(1);
    expect(harness.snapshot().preparationQueries).toHaveLength(1);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('keeps preparation SQL failure typed and retryable before any owner commit', () =>
  Effect.gen(function* retryPreparationRead() {
    const action = actionFor();
    let scripts = 0;
    const harness = yield* harnessFor(action, () =>
      Effect.suspend(() => {
        scripts += 1;
        return scripts === 1
          ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'preparation fixture unavailable' }) }))
          : Effect.succeed([{ value: 7 }]);
      }),
    );
    expect(
      Schema.is(ActionTransactionError)(yield* harness.runtime.runAction(requestFor(action)).pipe(Effect.flip)),
    ).toBe(true);
    expect(harness.snapshot().committed).toEqual([]);
    expect(yield* harness.runtime.runAction(requestFor(action))).toBe(7);
    expect(scripts).toBe(2);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('keeps the physical remote-I/O guard inside the original preparation snapshot', () =>
  Effect.gen(function* guardedPreparationRead() {
    const action = actionFor();
    const harness = yield* harnessFor(action, () =>
      refuseInsideDatabaseTransaction('spicedb', 'preparation-read-fixture').pipe(Effect.as([{ value: 7 }])),
    );
    expect(Exit.isFailure(yield* Effect.exit(harness.runtime.runAction(requestFor(action))))).toBe(true);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);
