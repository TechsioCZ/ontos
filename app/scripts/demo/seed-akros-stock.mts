#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { akrosMinimumStock } from '../../verticals/merchandise/scripts/akros-baseline.ts';
import { buildAkrosEncoded } from '../../verticals/merchandise/scripts/akros-catalog.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

const Query = Schema.Struct({
  view: Schema.Struct({
    limit: Schema.Int,
    offset: Schema.Int,
    ordersLimit: Schema.Int,
    productSort: Schema.Literal('sku'),
  }),
});
const Records = Schema.Struct({
  products: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      lowStock: Schema.Boolean,
      lowStockThreshold: Schema.Int,
      stockOnHand: Schema.Finite,
    }),
  ),
  revision: Schema.Int,
});
const command = Schema.toEncoded(MerchandiseCommandSchema);

/** Repair only imported groups. Never move stock, reprice, reset an order, or change a custom product. */
export const seedAkrosStock = (client: SeedClient, apply: boolean) =>
  Effect.gen(function* seedMinimums() {
    const minima = new Map(buildAkrosEncoded().products.map((product) => [product.id, product.lowStockThreshold]));
    let changed = 0;
    for (let offset = 0; ; offset += 250) {
      const snapshot = yield* client.call(
        'merchandise',
        '/reads/records',
        Query,
        { view: { limit: 250, offset, ordersLimit: 0, productSort: 'sku' } },
        Records,
      );
      let { revision } = snapshot;
      for (const product of snapshot.products) {
        const baselineMinimum = minima.get(product.id);
        const minimum = akrosMinimumStock(product.stockOnHand);
        if (
          baselineMinimum === undefined ||
          (product.lowStockThreshold === minimum && product.lowStock === (minimum > 0 && product.stockOnHand < minimum))
        ) {
          continue;
        }
        if (
          product.lowStockThreshold !== 5 &&
          product.lowStockThreshold !== baselineMinimum &&
          product.lowStockThreshold !== minimum
        ) {
          return yield* new DemoSeedError({
            reason: `Product ${product.id} has an edited minimum; no overwrite performed.`,
          });
        }
        changed += 1;
        if (apply) {
          const result = yield* client.apply(
            'merchandise',
            command,
            { _tag: 'UpdateProduct', id: product.id, patch: { lowStockThreshold: minimum } },
            revision,
          );
          ({ revision } = result);
        }
      }
      if (snapshot.products.length < 250) {
        break;
      }
    }
    yield* Console.log(
      `${apply ? 'Updated' : 'Would update'} ${changed} imported product minima. Prices, stock and orders are unchanged.`,
    );
    return changed;
  });

if (import.meta.main) {
  const cli = Command.make(
    'seed-akros-stock',
    { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
    ({ apply }) =>
      Effect.gen(function* main() {
        const target = {
          legalEntityId: akrosDemoLegalEntityId,
          shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020')),
          tenantId: demoTenantId,
        };
        const origin = yield* validateSeedTarget(target);
        const fs = yield* FileSystem.FileSystem;
        const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(
          Config.withDefault('.scratch/demo-seed'),
        );
        const checkpoint = seedWriteCheckpoint(fs, seedCheckpointDirectory({ ...target, shellUrl: origin }, root));
        const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD').pipe(
          Config.withDefault(Redacted.make('password1234')),
        );
        const email = yield* Config.String('ONTOS_DEMO_SEED_EMAIL').pipe(Config.withDefault('eshop@akros.demo'));
        const client = yield* connectSeedClient(target, email, password, checkpoint);
        yield* seedAkrosStock(client, apply);
      }),
  );
  const program = Command.run(cli, { version: '1.0.0' });
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.tapError((failure) =>
        Console.error(`Stock seed stopped (${failure._tag}); keep checkpoints before rerunning.`),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
