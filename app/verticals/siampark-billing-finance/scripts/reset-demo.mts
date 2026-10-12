import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  References,
  Schema,
  Tracer,
} from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { Command, Flag } from 'effect/unstable/cli';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import { derivePaymentState } from '../src/services/persistence.service.ts';
import { financeStates, financeRelations } from '../src/database/schema.ts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: FinanceStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const AdminDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
).pipe(Layer.provide(Reactivity.layer));

const writeState = Effect.fn('Finance.writeDemoState')(function* writeDemoState(input: typeof FixtureSchema.Type) {
  const state = yield* Schema.encodeEffect(FinanceStateSchema)(input.state);
  const db = yield* makeWithDefaults({ relations: financeRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(financeStates)
    .values({
      legalEntityId: input.legalEntityId,
      revision: 0,
      state,
      tenantId: input.tenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state, updatedAt: DateTime.toDateUtc(now) },
      target: [financeStates.tenantId, financeStates.legalEntityId],
    });
  yield* Console.log('Siampark finance demo state reset to revision 0');
});

const reset = Effect.fn('Finance.resetDemo')(function* resetDemo(fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* fs
    .readFileString(fixturePath)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
  const refs = [
    ...input.state.invoices.flatMap((record) => [
      record.ref,
      record.counterpartyRef,
      record.propertyRef,
      record.unitRef,
      record.contractRef,
      record.occupancyRef,
      record.taskRef,
    ]),
    ...input.state.financialPlanEntries.flatMap((record) => [record.ref, record.propertyRef]),
    ...input.state.accountingObservations.map((record) => record.invoiceRef),
    ...input.state.paymentObservations.map((record) => record.invoiceRef),
  ];
  if (refs.some((ref) => ref !== undefined && ref.tenantId !== input.tenantId)) {
    return yield* new ResetInputError({ reason: 'Every fixture reference must match the fixed demo tenant' });
  }
  if (
    input.state.invoices.some(
      (invoice) =>
        invoice.paidMinor > invoice.totalMinor ||
        invoice.paymentState !== derivePaymentState(invoice.paidMinor, invoice.totalMinor) ||
        invoice.dueDate < invoice.issueDate ||
        (invoice.direction === 'INCOMING' &&
          invoice.businessState === 'CONFIRMED' &&
          invoice.propertyRef === undefined) ||
        (invoice.accountingSyncState === 'SYNCED' && invoice.externalAccountingReference === undefined),
    )
  ) {
    return yield* new ResetInputError({
      reason: 'Invoice payment, accounting, dates or supplier anchors are inconsistent',
    });
  }
  const invoiceIds = new Set(input.state.invoices.map((invoice) => invoice.ref.resourceId));
  if (
    invoiceIds.size !== input.state.invoices.length ||
    [...input.state.accountingObservations, ...input.state.paymentObservations].some(
      (observation) => !invoiceIds.has(observation.invoiceRef.resourceId),
    ) ||
    input.state.financialPlanEntries.some((entry) => entry.periodEndExclusive <= entry.periodStart)
  ) {
    return yield* new ResetInputError({
      reason: 'Fixture identities, observation references or plan periods are inconsistent',
    });
  }
  return yield* Layer.build(Layer.effectDiscard(writeState(input)).pipe(Layer.provide(AdminDatabaseLive))).pipe(
    Effect.scoped,
  );
});
const command = Command.make('siampark-finance-reset', { fixture: Flag.String('fixture') }, ({ fixture }) =>
  reset(fixture),
);
const main = Command.run(command, { version: '1.0.0' });
const resetProgram = Layer.effectDiscard(main).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
      Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
      Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      Layer.succeed(References.MinimumLogLevel, 'Info'),
    ),
  ),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
