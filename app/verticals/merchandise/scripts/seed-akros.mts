import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Command, Flag } from 'effect/cli';
import { Clock, Config, ConfigProvider, Console, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { MerchandiseStateSchema } from '../shared/apis/records.ts';
import type { MerchandiseState } from '../shared/apis/records.ts';
import { readCompanySnapshot, writeCompanySnapshot } from './company-snapshot.ts';

import { buildAkrosEncoded } from './akros-catalog.mts';
import { mergeSeed, restoreCatalog } from './akros-merge.ts';
import { refreshAkrosOrderPresentation } from './order-presentation.ts';

class AkrosSeedInputError extends Schema.TaggedError<AkrosSeedInputError>()('AkrosSeedInputError', {
  reason: Schema.String,
}) {}

export const akrosLegalEntityId = '71000000-0000-4000-8000-000000000024';
export const buildAkrosState = () =>
  buildAkrosEncoded().pipe(Effect.flatMap(Schema.decodeEffect(MerchandiseStateSchema)));

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

const akrosScope = { legalEntityId: akrosLegalEntityId, tenantId: demoTenantId };

export { mergeSeed, restoreCatalog } from './akros-merge.ts';

const equivalentState = Schema.toEquivalence(Schema.toEncoded(MerchandiseStateSchema));
const logSeed = (seed: MerchandiseState) =>
  Console.log(
    `AKROS seed: ${seed.products.length} groups; ${seed.products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0)} variants; ${seed.categories?.length ?? 0} categories; ${seed.movements.length} movements`,
  );
const repairStoredPresentation = Effect.fn('Merchandise.repairAkrosPresentation')(function* repairPresentation(
  state: MerchandiseState,
) {
  const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(state);
  const repaired = refreshAkrosOrderPresentation(encoded);
  if (equivalentState(repaired, encoded)) {
    return yield* Console.log('AKROS contacts already presentable; nothing changed');
  }
  yield* writeCompanySnapshot(akrosScope, yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(repaired));
  return yield* Console.log(
    'AKROS fixture contacts refreshed; orders, statuses, replay identities and catalog preserved',
  );
});

const writeState = Effect.fn('Merchandise.writeAkrosState')(function* writeAkrosState(
  reset: boolean,
  restore: boolean,
  repairPresentation: boolean,
) {
  if (repairPresentation && (reset || restore)) {
    return yield* Effect.fail(
      new AkrosSeedInputError({ reason: 'Presentation repair cannot reset or restore the catalog' }),
    );
  }
  const seed = yield* buildAkrosState();
  yield* logSeed(seed);
  const stored = reset ? undefined : yield* readCompanySnapshot(akrosScope);
  if (repairPresentation) {
    if (stored === undefined) {
      return yield* Effect.fail(new AkrosSeedInputError({ reason: 'AKROS merchandise must already exist' }));
    }
    return yield* repairStoredPresentation(stored.state);
  }
  if (stored === undefined) {
    const started = yield* Clock.currentTimeMillis;
    yield* writeCompanySnapshot(akrosScope, seed);
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    return yield* Console.log(
      `AKROS merchandise (AKROS) ${reset ? 'reset' : 'created'} in ${elapsed} ms: ${seed.products.length} products, ${seed.movements.length} movements, ${seed.orders.length} orders`,
    );
  }
  const current = stored.state;
  const merged = restore ? restoreCatalog(current, seed) : mergeSeed(current, seed);
  const encodedCurrent = yield* Schema.encodeEffect(MerchandiseStateSchema)(current);
  const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(merged);
  if (!restore && equivalentState(encoded, encodedCurrent)) {
    return yield* Console.log(
      `AKROS merchandise (AKROS) already seeded: ${current.products.length} products, ${current.categories?.length ?? 0} categories, ${current.orders.length} orders; nothing changed`,
    );
  }
  yield* writeCompanySnapshot(akrosScope, merged);
  return yield* Console.log(
    restore
      ? `AKROS merchandise (AKROS) catalog restored to seed prices/variants; ${current.orders.length} orders kept`
      : `AKROS merchandise (AKROS) merged: +${merged.products.length - current.products.length} products, +${merged.movements.length - current.movements.length} movements, +${(merged.categories?.length ?? 0) - (current.categories?.length ?? 0)} categories; ${merged.orders.length} orders kept`,
  );
});

/** Merge the native company seed without reading or writing dotenv; existing orders and catalog edits stay intact. */
export const seedAkros = (environment: Readonly<Record<string, string>>) =>
  Layer.build(
    Layer.effectDiscard(writeState(false, false, false)).pipe(
      Layer.provide(AdminDatabaseLive),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    ),
  ).pipe(Effect.scoped, Effect.asVoid);

const command = Command.make(
  'merchandise-seed-akros',
  {
    repairOrderPresentation: Flag.Boolean('repair-order-presentation').pipe(Flag.withDefault(false)),
    reset: Flag.Boolean('reset').pipe(Flag.withDefault(false)),
    restoreCatalog: Flag.Boolean('restore-catalog').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ repairOrderPresentation, reset, restoreCatalog: restore, validateOnly }) =>
    validateOnly
      ? buildAkrosState().pipe(
          Effect.flatMap((state) =>
            Schema.encodeEffect(MerchandiseStateSchema)(state).pipe(
              Effect.andThen(
                Console.log(
                  `AKROS seed validated: ${state.products.length} products, ${state.movements.length} movements, ${state.categories?.length ?? 0} categories, ${state.orders.length} orders; no data changed`,
                ),
              ),
            ),
          ),
        )
      : Layer.build(
          Layer.effectDiscard(writeState(reset, restore, repairOrderPresentation)).pipe(
            Layer.provide(AdminDatabaseLive),
          ),
        ).pipe(Effect.scoped),
);

const appRoot = new URL('../../..', import.meta.url).pathname;

const program = Effect.gen(function* seedProgram() {
  const fileProvider = yield* ConfigProvider.fromDotEnv({ path: `${appRoot}.env` });
  const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
  return yield* Layer.build(
    Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(provider))),
    ),
  ).pipe(Effect.scoped);
});

if (import.meta.main) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
