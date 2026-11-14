import { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fromReadable } from '@effect/platform-node/NodeStream';
import { Config, Effect, Option, Predicate, Schema } from 'effect';

import type {
  applyModuleCredentialHandovers,
  holdOwnStoreCopy,
  makeHostedCredentialHolders,
} from '../../zerops/module-credentials.mts';

class C14ModuleCredentialChannelUnavailable extends Schema.TaggedError<C14ModuleCredentialChannelUnavailable>()(
  'C14ModuleCredentialChannelUnavailable',
  { reason: Schema.String },
) {}

// As `scripts/zerops/module-credentials.mts` declares a loaded unit's claim: a function export, typed by its source.
const hostFunction = <Function_,>() =>
  Schema.declare((cause: unknown): cause is Function_ => Predicate.isFunction(cause));
/** The host program's exports this child uses, checked as they load. */
const ModuleCredentialHostSchema = Schema.Struct({
  applyModuleCredentialHandovers: hostFunction<typeof applyModuleCredentialHandovers>(),
  holdOwnStoreCopy: hostFunction<typeof holdOwnStoreCopy>(),
  makeHostedCredentialHolders: hostFunction<typeof makeHostedCredentialHolders>(),
  MODULE_CREDENTIAL_CHANNEL_FD: Schema.Literal(3),
  MODULE_CREDENTIAL_HANDOVER_VARIABLE: Schema.String,
});

/**
 * The C14 owner and worker children serve one module each, like an owners process: they claim their one credential
 * store copy for that module and take its key on the host's private channel (file descriptor 3), never from the
 * environment. The host program is loaded from the workspace at run time and never bundled into the child, so it
 * claims the one store copy that the workspace's delegated gateway client reads. The parent hands the key over once
 * and closes its side, so the key is held before the child serves anything.
 */
export const holdC14ModuleCredential = Effect.fn('SymmyC14ModuleCredential.hold')(function* holdModuleCredential(
  appId: string,
) {
  // Both children run in `verticals/<app>`, two levels below the application root.
  const hostModule = pathToFileURL(path.resolve(process.cwd(), '../../scripts/zerops/module-credentials.mts')).href;
  const host = yield* Effect.tryPromise({
    catch: () => new C14ModuleCredentialChannelUnavailable({ reason: 'The module credential host did not load' }),
    try: async () => await Schema.decodeUnknownPromise(ModuleCredentialHostSchema)(await import(hostModule)),
  });
  const { holders, receiver } = yield* host.makeHostedCredentialHolders([appId]);
  yield* host.holdOwnStoreCopy(holders, [appId]);
  const handover = yield* Config.option(Config.String(host.MODULE_CREDENTIAL_HANDOVER_VARIABLE));
  if (Option.isNone(handover)) {
    return;
  }
  yield* host.applyModuleCredentialHandovers(
    receiver,
    fromReadable<Uint8Array, C14ModuleCredentialChannelUnavailable>({
      evaluate: () => new Socket({ fd: host.MODULE_CREDENTIAL_CHANNEL_FD, readable: true, writable: false }),
      onError: () => new C14ModuleCredentialChannelUnavailable({ reason: 'The handover channel could not be read' }),
    }),
  );
});
