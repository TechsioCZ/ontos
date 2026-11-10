#!/usr/bin/env node
/**
 * Splits one provisioning pass's output (read from standard input, never from a file or a variable) for a process that
 * starts owners itself, such as the local demo:
 *
 *   ... | node scripts/zerops/module-credential-handover.mts key <app-id>   # that module's key, for its own process
 *   ... | node scripts/zerops/module-credential-handover.mts handover       # the multi-owner handover, for its stdin
 *
 * It writes only the requested credential(s) to standard output and nothing to standard error but a failure's name.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Redacted, Schema, Stdio, Stream } from 'effect';
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

const key = Command.make('key', { appId: Argument.String('app-id') }, ({ appId }) =>
  Effect.gen(function* moduleKey() {
    const output = yield* readOutput;
    const credential = output.credentials[appId];
    if (credential === undefined) {
      return yield* new ModuleCredentialSplitError({ reason: `No module credential was issued for ${appId}` });
    }
    const stdio = yield* Stdio.Stdio;
    return yield* Stream.make(new TextEncoder().encode(Redacted.value(credential))).pipe(Stream.run(stdio.stdout()));
  }),
);

const handover = Command.make('handover', {}, () =>
  Effect.gen(function* multiOwnerHandover() {
    const output = yield* readOutput;
    const bytes = yield* encodeModuleCredentialHandover(output.credentials, Object.keys(output.credentials));
    const stdio = yield* Stdio.Stdio;
    return yield* Stream.make(bytes).pipe(Stream.run(stdio.stdout()));
  }),
);

const command = Command.make('module-credential-handover').pipe(Command.withSubcommands([key, handover]));

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
