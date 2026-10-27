#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const orderNumber = 'OBJ-2026-0007';

/** A normal audited staff cancellation, never demo marking, deletion or a stock-ledger bypass. */
export const cancelStageQaOrder = (client: SeedClient, apply: boolean) =>
  Effect.gen(function* cancelQaOrder() {
    const snapshot = yield* client.call(
      'merchandise',
      '/reads/records',
      RecordsRequestSchema,
      { view: { limit: 1, orderSearch: orderNumber, ordersLimit: 10 } },
      Schema.toEncoded(RecordsResponseSchema),
    );
    if ((snapshot.totalOrders ?? snapshot.orders.length) > snapshot.orders.length) {
      return yield* new DemoSeedError({ reason: 'Incomplete order lookup; no cancellation performed.' });
    }
    const matches = snapshot.orders.filter((order) => order.number === orderNumber);
    if (matches.length === 0) {
      yield* Console.log(`${orderNumber}: not found; no write performed.`);
      return 0;
    }
    const [order] = matches;
    if (
      matches.length !== 1 ||
      order === undefined ||
      order.channel !== 'STOREFRONT' ||
      order.contact?.name !== 'Stage QA' ||
      order.contact.email !== 'stage.qa.20261022@example.invalid'
    ) {
      return yield* new DemoSeedError({ reason: 'The order does not uniquely match the approved Stage QA identity.' });
    }
    if (order.status === 'CANCELLED') {
      yield* Console.log(`${orderNumber}: already cancelled; no write performed.`);
      return 0;
    }
    if (apply) {
      yield* client.apply(
        'merchandise',
        Schema.toEncoded(MerchandiseCommandSchema),
        { _tag: 'ChangeOrderStatus', id: order.id, reason: 'Testovací objednávka', status: 'CANCELLED' },
        snapshot.revision,
      );
    }
    yield* Console.log(`${apply ? 'Cancelled' : 'Would cancel'} ${orderNumber} through the native staff Action.`);
    return 1;
  });

const command = Command.make(
  'cancel-stage-qa-order',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    Effect.gen(function* main() {
      const target = {
        legalEntityId: akrosDemoLegalEntityId,
        shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL'),
        tenantId: demoTenantId,
      };
      const origin = yield* validateSeedTarget(target);
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(
        Config.withDefault('.scratch/demo-seed'),
      );
      const checkpoint = seedWriteCheckpoint(fs, seedCheckpointDirectory({ ...target, shellUrl: origin }, root));
      const email = yield* Config.String('ONTOS_DEMO_SEED_EMAIL').pipe(Config.withDefault('eshop@akros.demo'));
      const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD');
      const client = yield* connectSeedClient(target, email, password, checkpoint);
      yield* cancelStageQaOrder(client, apply);
    }).pipe(
      Effect.tapError(() =>
        Console.error('QA order cancellation stopped; no marking, deletion or direct stock repair.'),
      ),
    ),
);

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
