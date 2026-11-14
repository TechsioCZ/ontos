import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';

import { requiredEnvironment } from './integration-seed-process.mts';
import { seedFailure } from './integration-seed-model.mts';

/** Compose bootstraps only the schema. A relationship would mean the empty proof contract changed. */
export const openSeedSpiceDb = () =>
  Effect.gen(function* connectSeedSpiceDb() {
    const key = yield* requiredEnvironment('SPICEDB_PRESHARED_KEY');
    const endpoint = yield* requiredEnvironment('SPICEDB_ENDPOINT');
    const certificate = yield* requiredEnvironment('SPICEDB_CA_CERT');
    if (!/^(?:localhost|127\.0\.0\.1):[0-9]+$/u.test(endpoint)) {
      return yield* seedFailure('Seed SpiceDB endpoint must be the disposable loopback TLS service');
    }
    return yield* Effect.acquireRelease(
      Effect.try({
        try: () => v1.NewClientWithCustomCert(key, endpoint, Buffer.from(certificate)),
        catch: () => seedFailure('Unable to open the disposable SpiceDB TLS channel'),
      }),
      (client) => Effect.sync(() => client.close()),
    );
  });

export const snapshotSpiceDb = () =>
  Effect.gen(function* readSeedSpiceDb() {
    const client = yield* openSeedSpiceDb();
    const schema = yield* Effect.tryPromise({
      try: () => client.promises.readSchema(v1.ReadSchemaRequest.create({})),
      catch: () => seedFailure('Unable to read SpiceDB seed schema'),
    });
    const definitions = [...schema.schemaText.matchAll(/\bdefinition\s+([a-zA-Z0-9_/]+)\s*\{/gu)].map(
      (match) => match[1],
    );
    for (const resourceType of definitions) {
      const relationships = yield* Effect.tryPromise({
        try: () =>
          client.promises.readRelationships(
            v1.ReadRelationshipsRequest.create({
              consistency: { requirement: { oneofKind: 'fullyConsistent', fullyConsistent: true } },
              relationshipFilter: { resourceType },
              optionalLimit: 1,
            }),
          ),
        catch: () => seedFailure('Unable to verify empty SpiceDB bootstrap relationships'),
      });
      if (relationships.length !== 0) {
        return yield* seedFailure(
          'Proof unexpectedly wrote SpiceDB relationships; seed refuses to omit or export unreviewed authorization state',
        );
      }
    }
    return yield* Effect.succeed(schema.schemaText);
  });

export const restoreSpiceDb = (schemaText: string) =>
  Effect.gen(function* restoreSeedSpiceDb() {
    // Check emptiness before rewriting anything; the caller also checks before PostgreSQL mutations.
    yield* snapshotSpiceDb();
    const client = yield* openSeedSpiceDb();
    yield* Effect.tryPromise({
      try: () => client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: schemaText })),
      catch: () => seedFailure('Unable to restore SpiceDB seed schema'),
    });
    if ((yield* snapshotSpiceDb()) !== schemaText) {
      return yield* seedFailure('SpiceDB schema readback differs from the seed');
    }
    return yield* Effect.void;
  });
