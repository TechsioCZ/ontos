import { Command, Flag } from 'effect/unstable/cli';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { RelationshipsStateSchema } from '../shared/apis/records.ts';
import { relationshipsStates, relationshipsRelations } from '../src/database/schema.ts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: RelationshipsStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const reset = Effect.fn('ResetDemo.reset')(function* resetDemo(fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs.readFileString(fixturePath);
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))(data);
  if (
    input.state.activities.some(
      (activity) =>
        activity.ref.tenantId !== input.tenantId ||
        activity.ownerPrincipalRef.tenantId !== input.tenantId ||
        (activity.partyRef !== undefined && activity.partyRef.tenantId !== input.tenantId) ||
        (activity.counterpartyRef !== undefined && activity.counterpartyRef.tenantId !== input.tenantId) ||
        (activity.followUpTaskRef !== undefined && activity.followUpTaskRef.tenantId !== input.tenantId),
    ) ||
    input.state.emailObservations.some((observation) => observation.ownerResourceRef.tenantId !== input.tenantId)
  ) {
    return yield* new ResetInputError({ reason: 'Fixture references must match the fixed demo tenant' });
  }
  const state = yield* Schema.encodeEffect(RelationshipsStateSchema)(input.state);
  const db = yield* makeWithDefaults({ relations: relationshipsRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(relationshipsStates)
    .values({
      legalEntityId: input.legalEntityId,
      revision: 0,
      state,
      tenantId: input.tenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state, updatedAt: DateTime.toDateUtc(now) },
      target: [relationshipsStates.tenantId, relationshipsStates.legalEntityId],
    });
  return yield* Console.log('Siampark relationships demo state reset to revision 0');
});
const resetPgLive = PgClient.layerFrom(
  Effect.gen(function* resetPool() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
);
const cli = Command.make('reset-siampark-demo', { fixture: Flag.String('fixture') }, ({ fixture }) => reset(fixture));
const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(resetPgLive),
  Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnv()))),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)));
