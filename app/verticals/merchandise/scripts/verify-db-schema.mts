/// <reference types="node" />
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Console, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { Reactivity } from 'effect/unstable/reactivity';
import { OrderSchema } from '../shared/apis/records.ts';
import { ProductIdSchema } from '../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  categories,
  merchandiseRelations,
  orders,
  priceTiers,
  products,
  productVariants,
  stockMovements,
} from '../src/database/schema.ts';

class OwnerVerificationError extends Schema.TaggedError<OwnerVerificationError>()('OwnerVerificationError', {
  reason: Schema.String,
}) {}
const TABLES = [
  'catalog_heads',
  'products',
  'product_variants',
  'price_tiers',
  'categories',
  'stock_movements',
  'orders',
] as const;
const CatalogSchema = Schema.Struct({
  enabled: Schema.Boolean,
  forced: Schema.Boolean,
  no_external_fk: Schema.Boolean,
  policies: Schema.Int,
  primary_key: Schema.Boolean,
  relname: Schema.String,
  runtime_bypass: Schema.Boolean,
  runtime_create: Schema.Boolean,
  runtime_delete: Schema.Boolean,
  runtime_insert: Schema.Boolean,
  runtime_select: Schema.Boolean,
  runtime_super: Schema.Boolean,
  runtime_update: Schema.Boolean,
  runtime_usage: Schema.Boolean,
  unique_redemption: Schema.Boolean,
});
const SnapshotSchema = Schema.Struct({
  categories: Schema.Array(Schema.Struct({ id: Schema.String })),
  heads: Schema.Array(Schema.Struct({ revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
  movements: Schema.Array(Schema.Struct({ productId: ProductIdSchema })),
  orders: Schema.Array(Schema.Struct({ document: OrderSchema })),
  products: Schema.Array(Schema.Struct({ id: Schema.String })),
  tiers: Schema.Array(Schema.Struct({ productId: ProductIdSchema })),
  variants: Schema.Array(Schema.Struct({ productId: ProductIdSchema })),
});
const demoTenant = '70000000-0000-4000-8000-000000000020';
const demoCompany = '71000000-0000-4000-8000-000000000020';
const catalogMatches = (row: typeof CatalogSchema.Type) =>
  row.enabled &&
  row.forced &&
  row.policies === 4 &&
  row.primary_key &&
  row.no_external_fk &&
  row.runtime_select &&
  row.runtime_insert &&
  row.runtime_update &&
  row.runtime_delete &&
  row.runtime_usage &&
  !row.runtime_create &&
  !row.runtime_bypass &&
  !row.runtime_super &&
  row.unique_redemption;
interface CatalogSnapshot {
  readonly categories: readonly Pick<typeof categories.$inferSelect, 'id'>[];
  readonly heads: readonly Pick<typeof catalogHeads.$inferSelect, 'revision'>[];
  readonly movements: readonly Pick<typeof stockMovements.$inferSelect, 'productId'>[];
  readonly orders: readonly Pick<typeof orders.$inferSelect, 'document'>[];
  readonly products: readonly Pick<typeof products.$inferSelect, 'id'>[];
  readonly tiers: readonly Pick<typeof priceTiers.$inferSelect, 'productId'>[];
  readonly variants: readonly Pick<typeof productVariants.$inferSelect, 'productId'>[];
}
// An empty migrated catalog is ready; any existing catalog must remain internally consistent.
export const verifySnapshot = Effect.fn('Merchandise.verifySnapshot')(function* verifySnapshot(
  rows: CatalogSnapshot,
  requireSeed: boolean,
) {
  const snapshot = yield* Schema.decodeUnknownEffect(SnapshotSchema)(rows);
  const hasRows = Object.values(snapshot).some((values) => values.length > 0);
  const productIds = new Set(snapshot.products.map((product) => product.id));
  if (
    snapshot.heads.length > 1 ||
    (hasRows && snapshot.heads.length !== 1) ||
    (requireSeed && (snapshot.heads.length !== 1 || snapshot.products.length === 0)) ||
    [...snapshot.movements, ...snapshot.variants, ...snapshot.tiers].some((row) => !productIds.has(row.productId)) ||
    snapshot.orders.some((order) => order.document.lines.some((line) => !productIds.has(line.productId)))
  ) {
    return yield* new OwnerVerificationError({
      reason: 'Existing scoped catalog is inconsistent or the explicitly required seed is absent',
    });
  }
  return yield* Effect.void;
});
const runtimePgLive = PgClient.layerFrom(
  Effect.gen(function* runtimeConnection() {
    const pair = yield* loadDatabaseConnectionPair();
    return yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
  }),
).pipe(Layer.provide(Reactivity.layer));
const verification = Effect.fn('Merchandise.verifyDatabase')(function* verifyOwnerDatabase(requireSeed: boolean) {
  const client = yield* PgClient.PgClient;
  const db = yield* makeWithDefaults({ relations: merchandiseRelations });
  // PostgreSQL catalogs have no owner-local Drizzle tables.

  const catalog = yield* client
    .unsafe(
      `select c.relname,
    c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
    (select count(*)::int from pg_catalog.pg_policy where polrelid=c.oid) as policies,
    exists(select 1 from pg_catalog.pg_constraint where conrelid=c.oid and contype='p' and pg_get_constraintdef(oid) like '%tenant_id, legal_entity_id%') as primary_key,
    not exists(select 1 from pg_catalog.pg_constraint f join pg_catalog.pg_class target on target.oid=f.confrelid join pg_catalog.pg_namespace n on n.oid=target.relnamespace where f.conrelid=c.oid and f.contype='f' and n.nspname <> 'demo_merchandise') as no_external_fk,
    has_schema_privilege(current_user,n.oid,'usage') as runtime_usage,
    has_schema_privilege(current_user,n.oid,'create') as runtime_create,
    has_table_privilege(current_user,c.oid,'select') as runtime_select,
    has_table_privilege(current_user,c.oid,'insert') as runtime_insert,
    has_table_privilege(current_user,c.oid,'update') as runtime_update,
    has_table_privilege(current_user,c.oid,'delete') as runtime_delete,
    (select rolbypassrls from pg_catalog.pg_roles where rolname=current_user) as runtime_bypass,
    (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as runtime_super,
    exists(select 1 from pg_catalog.pg_constraint where conrelid='demo_merchandise.gateway_assertion_redemptions'::regclass and contype='p' and pg_get_constraintdef(oid) like '%issuer, audience, jti%') as unique_redemption
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='demo_merchandise' and c.relkind='r' and c.relname = any($1::text[])`,
      [TABLES],
    )
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CatalogSchema))));
  if (catalog.length !== TABLES.length || !catalog.every(catalogMatches)) {
    return yield* new OwnerVerificationError({
      reason: `RLS or runtime grants incomplete on: ${TABLES.filter((table) => !catalog.some((row) => row.relname === table && catalogMatches(row))).join(', ')}`,
    });
  }
  const ownerTables = [catalogHeads, products, productVariants, priceTiers, categories, stockMovements, orders];
  const countVisible = (tenantId: string, legalEntityId: string) =>
    client.withTransaction(
      Effect.gen(function* countScopedVisibility() {
        // Session settings are infrastructure; every business read uses its owner's typed table.
        yield* client`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`;
        const rows = yield* Effect.forEach(
          ownerTables,
          (table) =>
            db
              .select({ tenantId: table.tenantId })
              .from(table)
              .where(and(eq(table.tenantId, demoTenant), eq(table.legalEntityId, demoCompany)))
              .limit(1),
          { concurrency: 1 },
        );
        return rows.flat().length;
      }),
    );
  const unscoped = yield* Effect.forEach(
    ownerTables,
    (table) => db.select({ tenantId: table.tenantId }).from(table).limit(1),
    { concurrency: 1 },
  );
  if (unscoped.some((rows) => rows.length !== 0)) {
    return yield* new OwnerVerificationError({ reason: 'Unscoped runtime read exposed owner rows' });
  }
  const denied = yield* Effect.all(
    [
      countVisible('', demoCompany),
      countVisible(demoTenant, ''),
      countVisible('70000000-0000-4000-8000-000000000021', demoCompany),
      countVisible(demoTenant, '71000000-0000-4000-8000-000000000021'),
    ],
    { concurrency: 1 },
  );
  if (denied.some((count) => count !== 0)) {
    return yield* new OwnerVerificationError({ reason: 'Missing or foreign scope exposed the fixed demo rows' });
  }
  const snapshot = yield* client.withTransaction(
    Effect.gen(function* readScopedConsistency() {
      yield* client`select set_config('ontos.tenant_id', ${demoTenant}, true), set_config('ontos.legal_entity_id', ${demoCompany}, true)`;
      return {
        categories: yield* db.select({ id: categories.id }).from(categories),
        heads: yield* db.select({ revision: catalogHeads.revision }).from(catalogHeads),
        movements: yield* db.select({ productId: stockMovements.productId }).from(stockMovements),
        orders: yield* db.select({ document: orders.document }).from(orders),
        products: yield* db.select({ id: products.id }).from(products),
        tiers: yield* db.select({ productId: priceTiers.productId }).from(priceTiers),
        variants: yield* db.select({ productId: productVariants.productId }).from(productVariants),
      };
    }),
  );
  yield* verifySnapshot(snapshot, requireSeed);
  return yield* Effect.void;
});
const reportTypedFailure = (failure: Effect.Error<ReturnType<typeof verification>>) =>
  Console.error(
    Match.value(failure).pipe(
      Match.tag('OwnerVerificationError', ({ reason }) => reason),
      Match.orElse(() => 'Owner catalog or fixture decoding failed; details withheld'),
    ),
  );
const main = (requireSeed: boolean) =>
  verification(requireSeed).pipe(
    Effect.tapError(reportTypedFailure),
    Effect.tapCause((cause) =>
      Console.error('merchandise database verification failed; details withheld', {
        defects: Cause.hasDies(cause),
        typedFailures: Cause.hasFails(cause),
      }),
    ),
    Effect.tap(() =>
      Console.log(
        `merchandise database verification passed: catalog, nonce PK, runtime grants, existing scoped state and four denied scopes (${requireSeed ? 'seed required' : 'migration readiness'})`,
      ),
    ),
  );
const cli = Command.make(
  'verify-db-schema',
  {
    requireSeed: Flag.Boolean('require-seed').pipe(Flag.withDefault(false)),
  },
  ({ requireSeed }) => main(requireSeed),
);
const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(runtimePgLive),
  Layer.provide(NodeServices.layer),
);
if (import.meta.main) {
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLive)), { disableErrorReporting: true });
}
