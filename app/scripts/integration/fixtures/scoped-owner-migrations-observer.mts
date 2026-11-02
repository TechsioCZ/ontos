import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { loadApplicationMigrationInventory } from '../../application-migration-inventory.mts';
import {
  ApplicationMigrationObservationSchema,
  ApplicationMigrationPlanSchema,
} from '../../application-migration-plan.mts';
import {
  observeApplicationMigrationState,
  prepareApplicationMigrationPlan,
  readApplicationMigrationRequirements,
} from '../../application-migration-runtime.mts';

const NativeTargetsSchema = Schema.Array(
  Schema.Struct({
    database: Schema.NonEmptyString,
    databaseKind: Schema.Literals(['primary', 'portal-auth']),
    databaseOid: Schema.NonEmptyString,
    host: Schema.NonEmptyString,
    port: Schema.Int,
    systemIdentifier: Schema.NonEmptyString,
    user: Schema.NonEmptyString,
  }),
);

// Process output contains native metadata, never a connection string or credential.
export const ScopedOwnerNativeStateSchema = Schema.Struct({
  nativeTargets: NativeTargetsSchema,
  observations: Schema.Array(ApplicationMigrationObservationSchema),
});
export const ScopedOwnerPreparedPlanSchema = Schema.Struct({
  nativeTargets: NativeTargetsSchema,
  plan: ApplicationMigrationPlanSchema,
});

const program = Effect.gen(function* scopedOwnerMetadataOnly() {
  const operation = yield* Schema.decodeUnknownEffect(Schema.Literals(['observe', 'prepare']))(
    yield* Config.String('SCOPED_OWNER_NATIVE_OPERATION'),
  );
  if (operation === 'observe') {
    const streams = (yield* loadApplicationMigrationInventory()).filter(({ optional }) => !optional);
    const state = yield* observeApplicationMigrationState(streams);
    return yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(ScopedOwnerNativeStateSchema))(state));
  }
  const requirements = yield* readApplicationMigrationRequirements(
    yield* Config.String('SCOPED_OWNER_REQUIREMENTS_FILE'),
  );
  const { nativeTargets, plan } = yield* prepareApplicationMigrationPlan(requirements);
  return yield* Console.log(
    yield* Schema.encodeEffect(Schema.fromJsonString(ScopedOwnerPreparedPlanSchema))({ nativeTargets, plan }),
  );
});

if (import.meta.main) {
  NodeRuntime.runMain(
    program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
  );
}
