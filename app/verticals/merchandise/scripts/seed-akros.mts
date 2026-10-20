import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { and, eq } from 'drizzle-orm';
import { Command, Flag } from 'effect/unstable/cli';
import { Config, ConfigProvider, Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { MerchandiseStateSchema } from '../shared/apis/records.ts';
import { merchandiseRelations, merchandiseStates } from '../src/database/schema.ts';

import { buildAkrosEncoded } from './akros-catalog.mts';
import { mergeSeed, restoreCatalog } from './akros-merge.ts';
import { refreshAkrosOrderPresentation } from './order-presentation.ts';
export const akrosLegalEntityId = '71000000-0000-4000-8000-000000000024';
export const buildAkrosState = () => Schema.decodeUnknownEffect(MerchandiseStateSchema)(buildAkrosEncoded());

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

const whereEshop = and(
  eq(merchandiseStates.tenantId, demoTenantId),
  eq(merchandiseStates.legalEntityId, akrosLegalEntityId),
);

export { mergeSeed, restoreCatalog };

const writeState = Effect.fn('Merchandise.writeEshopState')(function* writeEshopState(
  reset: boolean,
  restore: boolean,
  repairPresentation: boolean,
) {
  if (repairPresentation && (reset || restore))
    return yield* Effect.fail(new Error('Presentation repair cannot reset or restore the catalog'));
  const seed = yield* buildAkrosState();
  const encodedSeed = yield* Schema.encodeEffect(MerchandiseStateSchema)(seed);
  yield* Console.log(
    `AKROS aggregate: ${JSON.stringify(encodedSeed).length} bytes; ${seed.products.length} groups; ${seed.products.reduce((sum, product) => sum + (product.variants?.length ?? 0), 0)} variants`,
  );
  const db = yield* makeWithDefaults({ relations: merchandiseRelations });
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const rows = yield* db.select().from(merchandiseStates).where(whereEshop).limit(1);
  const [row] = rows;
  if (repairPresentation) {
    if (row === undefined) return yield* Effect.fail(new Error('AKROS aggregate must already exist'));
    const repaired = refreshAkrosOrderPresentation(row.state as typeof MerchandiseStateSchema.Encoded);
    if (JSON.stringify(repaired) === JSON.stringify(row.state))
      return yield* Console.log('AKROS contacts already presentable; nothing changed');
    const decoded = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(repaired);
    const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(decoded);
    const changed = yield* db
      .update(merchandiseStates)
      .set({ revision: row.revision + 1, state: encoded, updatedAt: now })
      .where(and(whereEshop, eq(merchandiseStates.revision, row.revision)))
      .returning({ revision: merchandiseStates.revision });
    if (changed.length !== 1)
      return yield* Effect.fail(new Error('AKROS changed concurrently; retry the scoped repair'));
    return yield* Console.log(
      'AKROS fixture contacts refreshed; orders, statuses, replay identities and catalog preserved',
    );
  }
  if (row === undefined || reset) {
    const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(seed);
    yield* db
      .insert(merchandiseStates)
      .values({
        legalEntityId: akrosLegalEntityId,
        revision: 0,
        state: encoded,
        tenantId: demoTenantId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: { revision: 0, state: encoded, updatedAt: now },
        target: [merchandiseStates.tenantId, merchandiseStates.legalEntityId],
      });
    return yield* Console.log(
      `AKROS merchandise (AKROS) ${reset ? 'reset' : 'created'}: ${seed.products.length} products, ${seed.movements.length} movements, ${seed.orders.length} orders`,
    );
  }
  const current = yield* Schema.decodeUnknownEffect(MerchandiseStateSchema)(row.state);
  const merged = restore ? restoreCatalog(current, seed) : mergeSeed(current, seed);
  const encodedCurrent = yield* Schema.encodeEffect(MerchandiseStateSchema)(current);
  const encoded = yield* Schema.encodeEffect(MerchandiseStateSchema)(merged);
  if (!restore && JSON.stringify(encoded) === JSON.stringify(encodedCurrent)) {
    return yield* Console.log(
      `AKROS merchandise (AKROS) already seeded: ${current.products.length} products, ${current.categories?.length ?? 0} categories, ${current.orders.length} orders; nothing changed`,
    );
  }
  const changed = yield* db
    .update(merchandiseStates)
    .set({ revision: row.revision + 1, state: encoded, updatedAt: now })
    .where(and(whereEshop, eq(merchandiseStates.revision, row.revision)))
    .returning({ revision: merchandiseStates.revision });
  if (changed.length !== 1) return yield* Effect.fail(new Error('AKROS changed concurrently; retry the scoped import'));
  return yield* Console.log(
    restore
      ? `AKROS merchandise (AKROS) catalog restored to seed prices/variants; ${current.orders.length} orders kept`
      : `AKROS merchandise (AKROS) merged: +${merged.products.length - current.products.length} products, +${merged.movements.length - current.movements.length} movements, +${(merged.categories?.length ?? 0) - (current.categories?.length ?? 0)} categories; ${merged.orders.length} orders kept`,
  );
});

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

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
