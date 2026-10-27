import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

declare const admin: Layer.Layer<PgClient.PgClient>;
declare const prune: (apply: boolean) => Effect.Effect<void, never, PgClient.PgClient>;

const command = Command.make(
  'prune-demo-leftovers',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) => prune(apply).pipe(Effect.provide(admin)),
);

NodeRuntime.runMain(Command.run(command, { version: '0.1.0' }).pipe(Effect.provide(NodeServices.layer)));
