#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer } from 'effect';
import { Command, Flag } from 'effect/cli';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-transaction-guard.ts';
import {
  PeopleSearchSchemaPublicationError,
  publishPeopleSearchSchema,
} from '../../packages/core-runtime/src/people/people-search-schema-publication.ts';

/** Operator-only. Invoke with the target's existing secret/config delivery, never put credentials in arguments. */
const command = Command.make(
  'publish-people-search-schema',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  Effect.fn('PublishPeopleSearchSchema.command')(function* command({ apply }) {
    const config = yield* loadSpiceDbConfig();
    if (config.deploymentEnvironment !== 'stage' && config.deploymentEnvironment !== 'development') {
      return yield* new PeopleSearchSchemaPublicationError({
        reason: 'People search schema publication accepts only an explicit stage or development target',
      });
    }
    const client = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) =>
          Object.defineProperty(
            new PeopleSearchSchemaPublicationError({ reason: 'The schema operator connection is unavailable' }),
            'cause',
            { value: cause },
          ),
        try: () => openSpiceDbRpc(config, 10_000),
      }),
      (rpc) => Effect.sync(rpc.close),
    );
    const result = yield* publishPeopleSearchSchema(client, apply);
    return yield* Console.log(`People search schema: ${result.status}. No relationships were changed.`);
  }),
);
const cli = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer));
NodeRuntime.runMain(Effect.scoped(Layer.build(cli)));
