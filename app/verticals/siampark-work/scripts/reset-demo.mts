import { Command, Flag } from 'effect/unstable/cli';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, ConfigProvider, Console, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { WorkStateSchema } from '../shared/apis/records.ts';
import { workStates, workRelations } from '../src/database/schema.ts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: WorkStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const reset = Effect.fn('ResetDemo.reset')(function* resetDemo(fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs.readFileString(fixturePath);
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))(data);
  if (
    input.state.collection.ref.tenantId !== input.tenantId ||
    input.state.tasks.some(
      (task) =>
        task.ref.tenantId !== input.tenantId ||
        task.collectionRef.resourceId !== input.state.collection.ref.resourceId ||
        task.collectionRef.tenantId !== input.tenantId ||
        task.contextRefs.some((ref) => ref.tenantId !== input.tenantId) ||
        (task.ownerPrincipalRef !== undefined && task.ownerPrincipalRef.tenantId !== input.tenantId),
    )
  ) {
    return yield* new ResetInputError({ reason: 'Fixture references must match the fixed demo tenant and collection' });
  }
  const state = yield* Schema.encodeEffect(WorkStateSchema)(input.state);
  const db = yield* makeWithDefaults({ relations: workRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(workStates)
    .values({
      legalEntityId: input.legalEntityId,
      revision: 0,
      state,
      tenantId: input.tenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state, updatedAt: DateTime.toDateUtc(now) },
      target: [workStates.tenantId, workStates.legalEntityId],
    });
  return yield* Console.log('Siampark work demo state reset to revision 0');
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
