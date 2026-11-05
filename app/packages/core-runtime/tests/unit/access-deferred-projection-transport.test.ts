import { v1 } from '@authzed/authzed-node';
import { Effect, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeDeferredAccessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';

const missingConfiguration = new SpiceDbConfigError({ reason: 'SPICEDB_ENDPOINT is not set' });

it.effect('opens no engine connection and reads no configuration until the first projection call', () =>
  Effect.scoped(
    Effect.gen(function* deferredUntilFirstCall() {
      const loads = yield* Ref.make(0);
      const transport = yield* makeDeferredAccessProjectionTransport(
        Ref.update(loads, (count) => count + 1).pipe(Effect.andThen(Effect.fail(missingConfiguration))),
      );
      // Building the transport is what a backend does at start-up: it must not need SpiceDB yet.
      expect(yield* Ref.get(loads)).toBe(0);

      // The first call needs the engine, so an unreadable configuration fails it as unavailable, never a grant.
      const failure = yield* Effect.flip(transport.readRelationships(v1.ReadRelationshipsRequest.create({})));
      expect(failure.code).toBe('access_projection_unavailable');
      // The configuration is read once and the answer kept, so a later call does not read it again.
      yield* Effect.flip(transport.writeRelationships(v1.WriteRelationshipsRequest.create({})));
      expect(yield* Ref.get(loads)).toBe(1);
    }),
  ),
);
