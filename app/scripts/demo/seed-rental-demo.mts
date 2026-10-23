#!/usr/bin/env node
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient } from 'effect/unstable/http';

import { rentalSeed, seedRentalDemo } from './rental-seed.mts';
import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

const configuration = Config.all({
  email: Config.String('ONTOS_DEMO_SEED_EMAIL'),
  legalEntityId: Config.String('ONTOS_DEMO_SEED_LEGAL_ENTITY_ID'),
  password: Config.Redacted('ONTOS_DEMO_SEED_PASSWORD'),
  shellUrl: Config.String('ONTOS_DEMO_SEED_URL'),
  tenantId: Config.String('ONTOS_DEMO_SEED_TENANT_ID'),
});
const main = (apply: boolean, demoSignature: boolean) =>
  Effect.gen(function* seedDemo() {
    const { email, password, ...configuredTarget } = yield* configuration;
    const origin = yield* validateSeedTarget(configuredTarget);
    const target = { ...configuredTarget, shellUrl: origin };
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(Config.withDefault('.scratch/demo-seed'));
    const directory = seedCheckpointDirectory(target, root);
    const client = yield* connectSeedClient(configuredTarget, email, password, seedWriteCheckpoint(fs, directory));
    if (apply) {
      yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
    }
    const result = yield* seedRentalDemo(client, target, {
      apply,
      checkpointPath: path.join(directory, 'customer.json'),
      demoSignature,
    });
    yield* Console.log(
      `${result.applied ? 'Seed complete' : 'Read-only preflight passed'}: ${target.shellUrl}, tenant ${target.tenantId}, legal entity ${target.legalEntityId}.`,
    );
    yield* Console.log(
      `Siampark rental story (${rentalSeed.propertyName} and more): 2 buildings, 8 units, 5 tenants, 6 leases, contracts with signature evidence, service tasks and issued invoices across four months, with payments and overdue receivables. Existing matching records are retained.`,
    );
    if (demoSignature) {
      yield* Console.log('Signature evidence is DEMO metadata only; no PDF was uploaded or signed.');
    }
    if (!apply) {
      yield* Console.log('No business data changed. Run with --apply to seed this target.');
    }
  });
const command = Command.make(
  'rental-demo-seed',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    demoSignature: Flag.Boolean('demo-signature').pipe(Flag.withDefault(false)),
  },
  ({ apply, demoSignature }) =>
    main(apply, demoSignature).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : `Seeder stopped (${failure._tag}); configuration, credentials and response bodies are not logged.`,
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
