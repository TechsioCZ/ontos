#!/usr/bin/env node
/**
 * Turns one provisioning pass's output (read from standard input, a pipe from the caller's memory, never a file) into
 * the handover line of one process, for a launcher that starts owners itself, such as the local demo:
 *
 *   ... | node scripts/zerops/module-credential-handover.mts handover [<app-id> ...] >"$channel"
 *
 * It writes exactly the named owners' credentials (all of the pass's, when none are named) to standard output, which
 * the launcher points at that process's private channel, and nothing to standard error but a failure's name.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Schema, Stdio, Stream } from 'effect';
import { Argument, Command } from 'effect/cli';

import { encodeModuleCredentialHandover, ProvisioningOutputJsonSchema } from './module-credentials.mts';

class ModuleCredentialSplitError extends Schema.TaggedError<ModuleCredentialSplitError>()(
  'ModuleCredentialSplitError',
  { reason: Schema.String },
) {}

const readOutput = Effect.gen(function* readProvisioningOutput() {
  const stdio = yield* Stdio.Stdio;
  const text = yield* stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError(() => new ModuleCredentialSplitError({ reason: 'The provisioning output could not be read' })),
  );
  return yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(text.trim()).pipe(
    Effect.mapError(() => new ModuleCredentialSplitError({ reason: 'The provisioning output is malformed' })),
  );
});

const handover = Command.make(
  'handover',
  { owners: Argument.String('app-id').pipe(Argument.variadic()) },
  ({ owners }) =>
    Effect.gen(function* multiOwnerHandover() {
      const output = yield* readOutput;
      const bytes = yield* encodeModuleCredentialHandover(
        output.credentials,
        owners.length === 0 ? Object.keys(output.credentials) : owners,
      );
      const stdio = yield* Stdio.Stdio;
      return yield* Stream.make(bytes).pipe(Stream.run(stdio.stdout()));
    }),
);

const command = Command.make('module-credential-handover').pipe(Command.withSubcommands([handover]));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(ModuleCredentialSplitError)(failure) ? failure.reason : 'module-credential-handover failed',
        ),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
