#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import {
  addContactPointWithAuthorization,
  counterpartyCustomerOnboardWithAuthorization,
  createPartyWithAuthorization,
  executeCustomerListWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  resolvePartyCommandCommitWithAuthorization,
} from '@app/party-registry/api/client';
import type { PartyCommandOptions } from '@app/party-registry/api/client';
import { Config, Console, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { MerchandiseCommandSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsRequestSchema, RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import { convertOrderCustomer } from '../../verticals/merchandise/shared/order-customer-conversion.ts';
import { orderCustomerSeedEligible } from '../../verticals/merchandise/scripts/order-presentation.ts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

type WriteOptions = Pick<PartyCommandOptions, 'correlationId' | 'idempotencyKey'>;
interface Routing {
  readonly baseUrl: string;
  readonly compositionRevision: string;
}

/** Generated native clients keep typed commit outcomes; no direct Party or commerce database writes. */
const ownersFor = (client: SeedClient) => {
  const authorized = <A, E, R>(run: (credential: Redacted.Redacted, routing: Routing) => Effect.Effect<A, E, R>) =>
    client.authorize('party-registry').pipe(Effect.flatMap(({ credential, options }) => run(credential, options)));
  return {
    contact: (payload: Parameters<typeof addContactPointWithAuthorization>[0], options: WriteOptions) =>
      authorized((credential, routing) =>
        addContactPointWithAuthorization(payload, Redacted.value(credential), { ...routing, ...options }),
      ).pipe(Effect.asVoid),
    create: (payload: Parameters<typeof createPartyWithAuthorization>[0], options: WriteOptions) =>
      authorized((credential, routing) =>
        createPartyWithAuthorization(payload, Redacted.value(credential), { ...routing, ...options }),
      ),
    customers: authorized((credential, routing) =>
      executeCustomerListWithAuthorization({ limit: 500 }, Redacted.value(credential), 'order-customer-list', routing),
    ).pipe(Effect.map(({ items }) => items)),
    detail: (payload: Parameters<typeof executeDuplicateCandidateDetailWithAuthorization>[0]) =>
      authorized((credential, routing) =>
        executeDuplicateCandidateDetailWithAuthorization(
          payload,
          Redacted.value(credential),
          'order-customer-review',
          routing,
        ),
      ),
    onboard: (payload: Parameters<typeof counterpartyCustomerOnboardWithAuthorization>[0], options: WriteOptions) =>
      authorized((credential, routing) =>
        counterpartyCustomerOnboardWithAuthorization(payload, Redacted.value(credential), { ...routing, ...options }),
      ),
    recover: (key: string) =>
      authorized((credential, routing) =>
        resolvePartyCommandCommitWithAuthorization(
          { actionKey: 'party.registry.create-party', idempotencyKey: key },
          Redacted.value(credential),
          { ...routing, correlationId: 'merchandise-order-customer-recovery' },
        ),
      ),
    resolve: (payload: Parameters<typeof resolveDuplicateCandidateCreateWithAuthorization>[0], options: WriteOptions) =>
      authorized((credential, routing) =>
        resolveDuplicateCandidateCreateWithAuthorization(payload, Redacted.value(credential), {
          ...routing,
          ...options,
        }),
      ),
  };
};

const main = (apply: boolean, includeRealOrders: boolean) =>
  Effect.gen(function* seed() {
    const target = {
      legalEntityId: akrosDemoLegalEntityId,
      shellUrl: yield* Config.String('ONTOS_DEMO_SEED_URL'),
      tenantId: demoTenantId,
    };
    const origin = yield* validateSeedTarget(target);
    const email = yield* Config.String('ONTOS_DEMO_SEED_EMAIL').pipe(Config.withDefault('eshop@akros.demo'));
    const password = yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD');
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(Config.withDefault('.scratch/demo-seed'));
    const checkpoint = seedWriteCheckpoint(fs, seedCheckpointDirectory({ ...target, shellUrl: origin }, root));
    const client = yield* connectSeedClient(target, email, password, checkpoint);
    const owners = ownersFor(client);
    type OwnerEffect =
      | ReturnType<Exclude<(typeof owners)[keyof typeof owners], typeof owners.customers>>
      | typeof owners.customers;
    const records = yield* client
      .call(
        'merchandise',
        '/reads/records',
        RecordsRequestSchema,
        { view: { limit: 1, ordersLimit: 250 } },
        Schema.toEncoded(RecordsResponseSchema),
      )
      .pipe(Effect.flatMap(Schema.decodeEffect(RecordsResponseSchema)));
    if ((records.totalOrders ?? records.orders.length) > records.orders.length) {
      yield* new DemoSeedError({ reason: 'Order page is incomplete; refusing an incomplete backfill.' });
    }
    let { revision } = records;
    let converted = 0;
    for (const order of records.orders) {
      if (!orderCustomerSeedEligible(order, includeRealOrders)) {
        continue;
      }
      const customers = yield* owners.customers;
      if (!customers.some((customer) => customer.partyId === order.partyId && customer.status === 'ACTIVE')) {
        if (apply) {
          const customer = yield* convertOrderCustomer<Effect.Error<OwnerEffect>, Effect.Services<OwnerEffect>>(
            order,
            owners,
          );
          const command = yield* Schema.decodeEffect(MerchandiseCommandSchema)({
            _tag: 'LinkOrderCustomer',
            ...customer,
            expectedPartyId: order.partyId,
            id: order.id,
          });
          ({ revision } = yield* client.apply('merchandise', MerchandiseCommandSchema, command, revision, [
            'party-registry',
          ]));
        }
        converted += 1;
      }
    }
    yield* Console.log(
      `${apply ? 'Converted' : 'Would convert'} ${converted} order customers through native Party/CUSTOMER Actions. ${includeRealOrders ? 'Operator explicitly included real orders.' : 'Only the six known seeded demo orders were eligible.'}`,
    );
  });

const command = Command.make(
  'order-customer-seed',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    includeRealOrders: Flag.Boolean('include-real-orders').pipe(Flag.withDefault(false)),
  },
  ({ apply, includeRealOrders }) =>
    main(apply, includeRealOrders).pipe(
      Effect.tapError(() =>
        Console.error(
          'Customer backfill stopped. No guest identity was guessed. Keep the same operator account when retrying; review any native duplicate case before continuing.',
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
