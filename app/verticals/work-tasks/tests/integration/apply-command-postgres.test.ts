import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  ApplyCommandPayloadSchema,
  WorkLifecycleConflict,
  WorkReferenceUnavailable,
  WorkRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { SubmitStorefrontInquiryPayloadSchema } from '../../shared/actions/submit-storefront-inquiry.ts';
import { prepareApplyCommandServices } from '../../src/actions/apply-command.action.ts';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import { and, eq } from 'drizzle-orm';
import { PrincipalIdSchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import { workRelations, workStates } from '../../src/database/schema.ts';
import { referenceTransportNotUsed } from '../support/reference-transport.ts';
import { WorkReferenceVerifier, persistenceService } from '../../src/services/persistence.service.ts';
import type { WorkRecordsGrants } from '../../src/services/persistence.service.ts';

const nativeWorkCommands = Effect.scoped(
  Effect.gen(function* nativeWorkCommands() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: workRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'session:work-command-test',
      authMethod: 'session',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'work-command-test' };
    const resourceId = yield* crypto.randomUUIDv4();
    const taskRef = yield* Schema.decodeEffect(TaskRefSchema)({
      moduleId: 'work.tasks',
      resourceId,
      resourceType: 'work.tasks.task',
      tenantId: scope.tenantId,
    });
    const context: ActionServicePreparationContext = {
      actionInvocationId: yield* crypto.randomUUIDv4(),
      compositionRevision: 'work-command-composition',
      scope,
      transaction: () => Effect.die('Command permission checks need no SQL snapshot'),
    };
    let insideTransaction = false;
    let referenceChecks = 0;
    const create = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: { _tag: 'CreateTask', title: 'Kontrola provozu' },
      expectedRevision: 0,
    });
    const update = yield* Schema.decodeEffect(ApplyCommandPayloadSchema)({
      command: {
        _tag: 'UpdateTask',
        contextRefs: [
          {
            moduleId: 'property.portfolio',
            resourceId: yield* crypto.randomUUIDv4(),
            resourceType: 'property.portfolio.property',
            tenantId: scope.tenantId,
          },
        ],
        taskRef,
        title: 'Kontrola dokončena',
      },
      expectedRevision: 1,
    });
    const createFactory = yield* prepareApplyCommandServices(create, context);
    const updateFactory = yield* prepareApplyCommandServices(update, context).pipe(
      Effect.provideService(WorkReferenceVerifier, {
        verify: () =>
          Effect.sync(() => {
            expect(insideTransaction).toBe(false);
            referenceChecks += 1;
          }),
      }),
    );
    expect(referenceChecks).toBe(1);
    const result = yield* database
      .transaction(
        Effect.fn('WorkCommandsTest.transaction')(function* nativeTransaction(tx) {
          insideTransaction = true;
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const creator = yield* createFactory(scoped, scope, context.compositionRevision);
          const created = yield* creator.apply(create.command, 0, resourceId);
          expect(created.revision).toBe(1);
          const updater = yield* updateFactory(scoped, scope, context.compositionRevision);
          const updated = yield* updater.apply(update.command, 1, resourceId);
          expect(updated).toMatchObject({ revision: 2, task: { title: 'Kontrola dokončena' } });
          const stale = yield* updater.apply(update.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(WorkRevisionConflict)(stale)).toBe(true);
          const changed = yield* updater.apply(create.command, 1, resourceId).pipe(Effect.flip);
          expect(Schema.is(WorkReferenceUnavailable)(changed)).toBe(true);
          const unprepared = yield* persistenceService(scoped, { scope });
          expect(
            Schema.is(WorkReferenceUnavailable)(
              yield* unprepared.apply(create.command, 0, resourceId).pipe(Effect.flip),
            ),
          ).toBe(true);
          for (const other of [
            { ...scope, principalId: scope.tenantId },
            { ...scope, tenantId: scope.principalId },
            { ...scope, legalEntityId: scope.principalId },
            { ...scope, correlationId: 'another-invocation' },
          ]) {
            expect(
              Schema.is(OperationContextUnavailable)(
                yield* updateFactory(scoped, other, context.compositionRevision).pipe(Effect.flip),
              ),
            ).toBe(true);
          }
          expect(
            Schema.is(OperationContextUnavailable)(
              yield* updateFactory(scoped, scope, 'another-composition').pipe(Effect.flip),
            ),
          ).toBe(true);
          expect(referenceChecks).toBe(1);
          // PostgreSQL must filter private JSONB rows itself, not return the full state for JS filtering.
          const [row] = yield* scoped
            .select()
            .from(workStates)
            .where(
              and(eq(workStates.tenantId, scope.tenantId), eq(workStates.legalEntityId, scope.legalEntityId ?? '')),
            )
            .limit(1);
          if (row === undefined) {
            return yield* Effect.die('Missing native Work snapshot');
          }
          const state = yield* Schema.decodeUnknownEffect(WorkStateSchema)(row.state);
          const [task] = state.tasks;
          if (task === undefined) {
            return yield* Effect.die('Missing native Task');
          }
          const otherRef = yield* Schema.decodeEffect(TaskRefSchema)({ ...task.ref, resourceId: 'other-task' });
          const foreignOwnerRef = yield* Schema.decodeEffect(TaskRefSchema)({
            ...task.ref,
            resourceId: 'foreign-owner-task',
          });
          const enriched = yield* Schema.decodeUnknownEffect(Schema.toType(WorkStateSchema))({
            ...state,
            tasks: [
              { ...task, ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.tenantId } },
              {
                ...task,
                ownerPrincipalRef: { principalId: scope.authBindingId, tenantId: scope.tenantId },
                ref: otherRef,
              },
              {
                ...task,
                ownerPrincipalRef: { principalId: scope.principalId, tenantId: scope.authBindingId },
                ref: foreignOwnerRef,
              },
            ],
          });
          yield* scoped
            .update(workStates)
            .set({ state: yield* Schema.encodeEffect(WorkStateSchema)(enriched) })
            .where(
              and(eq(workStates.tenantId, scope.tenantId), eq(workStates.legalEntityId, scope.legalEntityId ?? '')),
            );
          const grants: WorkRecordsGrants = {
            lookupAccess: {
              contracts: 'denied',
              customers: 'denied',
              opportunities: 'denied',
              properties: 'denied',
            } as const,
            predicate: {
              groups: [
                {
                  clauses: [
                    {
                      conditions: [
                        {
                          _tag: 'AssignedTo' as const,
                          holder: {
                            _tag: 'Principal' as const,
                            principalId: PrincipalIdSchema.make(scope.principalId),
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            readAll: false,
            writeAll: false,
          };
          const own = yield* unprepared.loadRecords(grants);
          const ownState = yield* Schema.decodeUnknownEffect(WorkStateSchema)(own.state);
          expect(ownState.tasks.map(({ ref }) => ref.resourceId)).toEqual([task.ref.resourceId]);
          const target: WorkRecordsGrants = {
            ...grants,
            predicate: {
              groups: [
                ...grants.predicate.groups,
                {
                  clauses: [
                    {
                      conditions: [
                        {
                          _tag: 'RecordKeyIn' as const,
                          recordKeys: [RecordKeySchema.make(otherRef.resourceId)] as const,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          };
          const empty = yield* unprepared.loadRecords(target);
          expect((yield* Schema.decodeUnknownEffect(WorkStateSchema)(empty.state)).tasks).toEqual([]);
          const all = yield* unprepared.loadRecords({ ...grants, predicate: { groups: [] }, readAll: true });
          expect((yield* Schema.decodeUnknownEffect(WorkStateSchema)(all.state)).tasks).toHaveLength(3);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
).pipe(Effect.provide(referenceTransportNotUsed));

/** A storefront inquiry writes on the current revision, replays its request id and refuses a reused one. */
const storefrontInquiries = Effect.scoped(
  Effect.gen(function* storefrontInquiries() {
    const crypto = yield* Crypto.Crypto;
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const database = yield* makeWithDefaults({ relations: workRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: yield* crypto.randomUUIDv4(),
      authContextRef: 'api_key:storefront-inquiry-test',
      authMethod: 'api_key',
      legalEntityId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
      tenantId: yield* crypto.randomUUIDv4(),
    });
    const scope: OperationalScope = { ...principal, correlationId: 'storefront-inquiry-test' };
    const inquiryOf = Effect.fn('StorefrontInquiryTest.inquiry')(function* inquiryOf(
      requestId: string,
      message: string,
    ) {
      const payload = yield* Schema.decodeEffect(SubmitStorefrontInquiryPayloadSchema)({
        description: 'Kontakt: Jana Nováková',
        storefrontInquiry: {
          email: 'zakaznik@example.cz',
          kind: 'CONTACT',
          message,
          name: 'Jana Nováková',
          requestId,
          subject: 'Dotaz',
        },
        title: 'Dotaz z e-shopu',
      });
      return { _tag: 'CreateTask' as const, ...payload };
    });
    const first = yield* inquiryOf(yield* crypto.randomUUIDv4(), 'Máte otevřeno v sobotu?');
    const second = yield* inquiryOf(yield* crypto.randomUUIDv4(), 'Posíláte i na Slovensko?');
    const reused = yield* inquiryOf(first.storefrontInquiry.requestId, 'Jiný text pod stejným id');
    const result = yield* database
      .transaction(
        Effect.fn('StorefrontInquiryTest.transaction')(function* inquiryTransaction(tx) {
          const scoped = yield* installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([]));
          const services = yield* persistenceService(scoped, { scope });
          const firstId = yield* crypto.randomUUIDv4();
          const created = yield* services.submitStorefrontInquiry(first, firstId);
          expect(created.revision).toBe(1);
          expect(created.task).toMatchObject({ priority: 'NORMAL', ref: { resourceId: firstId }, state: 'NEW' });
          expect(created.task).not.toHaveProperty('ownerPrincipalRef');
          // A retried submission answers the task it already created and writes nothing.
          const replayed = yield* services.submitStorefrontInquiry(first, yield* crypto.randomUUIDv4());
          expect(replayed).toMatchObject({ revision: 1, task: { ref: { resourceId: firstId } } });
          const conflict = yield* services
            .submitStorefrontInquiry(reused, yield* crypto.randomUUIDv4())
            .pipe(Effect.flip);
          expect(Schema.is(WorkLifecycleConflict)(conflict)).toBe(true);
          // A second inquiry needs no revision from the caller: it lands on whatever the company holds now.
          const next = yield* services.submitStorefrontInquiry(second, yield* crypto.randomUUIDv4());
          expect(next.revision).toBe(2);
          const [row] = yield* scoped
            .select()
            .from(workStates)
            .where(
              and(eq(workStates.tenantId, scope.tenantId), eq(workStates.legalEntityId, scope.legalEntityId ?? '')),
            )
            .limit(1);
          const state = yield* Schema.decodeUnknownEffect(WorkStateSchema)(row?.state);
          expect(state.tasks.map((task) => task.storefrontInquiry?.requestId)).toEqual([
            first.storefrontInquiry.requestId,
            second.storefrontInquiry.requestId,
          ]);
          return yield* Effect.fail('fixture-rollback' as const);
        }),
      )
      .pipe(Effect.flip);
    expect(result).toBe('fixture-rollback');
  }),
);

it.layer(NodeCrypto.layer, { excludeTestServices: true })('native task commands', (suite) => {
  suite.effect(
    'files storefront inquiries without a caller revision, replays a request id and refuses a reused one',
    () => storefrontInquiries,
  );
  suite.effect(
    'keeps references outside SQL, preserves CAS and preparation binding, and filters assigned JSONB rows in PostgreSQL',
    () => nativeWorkCommands,
  );
});
