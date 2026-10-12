import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Console, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';

import { PropertyStateSchema } from '../shared/apis/records.ts';
import { propertyRelations, propertyState } from '../src/database/schema.ts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: PropertyStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const main = (fixturePath: string) =>
  Effect.gen(function* resetPropertyDemo() {
    const fs = yield* FileSystem.FileSystem;
    const input = yield* fs
      .readFileString(fixturePath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
    const refs = [
      ...input.state.properties.flatMap((row) => [row.propertyRef, row.legalEntityRef]),
      ...input.state.units.flatMap((row) => [row.unitRef, row.propertyRef]),
      ...input.state.assets.flatMap((row) => [
        row.assetRef,
        row.propertyRef,
        ...(row.unitRef === null ? [] : [row.unitRef]),
      ]),
    ];
    if (
      refs.some((ref) => ref.tenantId !== input.tenantId) ||
      input.state.properties.some((row) => row.legalEntityRef.resourceId !== input.legalEntityId)
    ) {
      return yield* new ResetInputError({ reason: 'All fixture references must belong to the fixed demo scope' });
    }
    const db = yield* makeWithDefaults({ relations: propertyRelations });
    const now = yield* DateTime.nowAsDate;
    yield* db
      .insert(propertyState)
      .values({
        legalEntityId: input.legalEntityId,
        payload: input.state,
        revision: 0,
        tenantId: input.tenantId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: { payload: input.state, revision: 0, updatedAt: now },
        target: [propertyState.tenantId, propertyState.legalEntityId],
      });
    return yield* Console.log('Siampark property demo reset to revision 0');
  });
const command = Command.make('demo-fixture', { fixture: Flag.String('fixture') }, ({ fixture }) =>
  main(fixture).pipe(Effect.tapError((failure) => Console.error(`Fixture port failed: ${failure._tag}`))),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      PgClient.layerConfig({ url: Config.Redacted('DATABASE_ADMIN_URL') }).pipe(Layer.provide(Reactivity.layer)),
    ),
  ),
);
await Effect.runPromise(Effect.scoped(Layer.build(runtimeLive)));
