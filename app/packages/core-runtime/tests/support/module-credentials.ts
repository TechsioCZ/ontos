import { Deferred, Effect, Option, Redacted, Schema } from 'effect';

import topology from '../../../../topology/reference-topology.json' with { type: 'json' };

import { claimHostedModuleCredentials } from '../../src/auth/hosted-module-credential-store.ts';
import type { HostedModuleCredentialReceiver } from '../../src/auth/hosted-module-credentials.ts';

/**
 * Hands a test process module credentials the way the host does: through a claimed store copy, never through the
 * environment (there is no environment variable to read a module key from). The store copy of the test's bundle is
 * claimed once, for every topology module; each call then gives the named modules their key, replacing the one they
 * held, and a module never named holds none (its delegated calls fail closed).
 */
const TopologySchema = Schema.Struct({ verticals: Schema.Array(Schema.Struct({ id: Schema.String })) });

const topologyModules = (): readonly string[] =>
  Schema.decodeUnknownSync(TopologySchema)(topology).verticals.map(({ id }) => id);

const claimed = Deferred.makeUnsafe<HostedModuleCredentialReceiver>();

const receiver = Effect.gen(function* testReceiver() {
  const held = yield* Deferred.poll(claimed);
  if (Option.isSome(held)) {
    return yield* held.value;
  }
  const fresh = yield* claimHostedModuleCredentials(topologyModules()).pipe(Effect.orDie);
  yield* Deferred.succeed(claimed, fresh);
  return fresh;
});

/** Gives each named module its key (and, optionally, internal workload keys) in this test process. */
export const holdTestModuleCredentials = (
  credentials: Readonly<Record<string, string>>,
  workloads: Readonly<Record<string, string>> = {},
) =>
  receiver.pipe(
    Effect.flatMap((copy) =>
      copy.accept({
        credentials: Object.fromEntries(Object.entries(credentials).map(([appId, key]) => [appId, Redacted.make(key)])),
        schemaVersion: 1,
        workloads: Object.fromEntries(Object.entries(workloads).map(([entry, key]) => [entry, Redacted.make(key)])),
      }),
    ),
    Effect.asVoid,
  );
