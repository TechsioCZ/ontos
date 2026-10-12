/// <reference types="node" />
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';
import { OccupancyStateSchema } from '../shared/apis/records.ts';
import { occupancyState } from '../src/database/schema.ts';

const PayloadSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: OccupancyStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const cli = Command.make(
  'reset-siampark-occupancy-demo',
  { fixture: Flag.String('fixture') },
  Effect.fn('siampark-occupancy.resetDemo')(function* cli({ fixture }) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(fixture) || !fixture.endsWith('.json')) {
      return yield* new ResetInputError({ reason: 'Use --fixture /absolute/file.json' });
    }
    const fs = yield* FileSystem.FileSystem;
    const input = yield* Schema.decodeEffect(Schema.fromJsonString(PayloadSchema))(yield* fs.readFileString(fixture));
    const refs: readonly ({ readonly tenantId: string } | null)[] = [
      ...input.state.occupancies.flatMap((row) => [
        row.occupancyRef,
        row.unitRef,
        row.contractRef,
        row.customerCounterpartyRef,
        row.guestPartyRef,
      ]),
      ...input.state.bookingObservations.flatMap((row) => [row.occupancyRef, row.ownerResourceRef]),
    ];
    if (refs.some((ref) => ref !== null && ref.tenantId !== input.tenantId)) {
      return yield* new ResetInputError({ reason: 'All fixture references must match the fixed demo tenant' });
    }
    const snapshot = yield* Schema.encodeEffect(OccupancyStateSchema)(input.state);
    const db = yield* makeWithDefaults({ relations: defineRelations({ occupancyState }) });
    yield* db
      .insert(occupancyState)
      .values({ legalEntityId: input.legalEntityId, revision: 0, snapshot, tenantId: input.tenantId })
      .onConflictDoUpdate({
        set: { revision: 0, snapshot },
        target: [occupancyState.tenantId, occupancyState.legalEntityId],
      });
    return yield* Console.log('siampark-occupancy fixture reset to revision 0');
  }),
);
const resetPg = Config.schema(Schema.RedactedFromValue(Schema.NonEmptyString), 'DATABASE_ADMIN_URL').pipe(
  Effect.flatMap((url) => PgClient.makeClient({ url })),
);
const mainLive = Layer.effectDiscard(
  Command.run(cli.pipe(Command.provideEffect(PgClient.PgClient, resetPg)), { version: '1.0.0' }),
).pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
const result = await Effect.runPromiseExit(
  Effect.scoped(Layer.build(mainLive)).pipe(
    Effect.tapCause((cause) =>
      Console.error(
        'Owner fixture reset failed',
        cause.reasons.map((reason) => reason._tag),
      ),
    ),
  ),
);
if (Exit.isFailure(result)) {
  process.exitCode = 1;
}
