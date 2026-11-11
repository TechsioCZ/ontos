/**
 * The platform's module credentials on a host: who gets one, how a provisioning pass reports them, and how a process
 * that serves several owners receives them. Keys travel only over pipes between processes and live only in their
 * memory; they are never logged, written to disk or put in an environment variable. A process's channel is its file
 * descriptor 3; its standard output and standard error stay logs, so a stray log line never reaches a handover.
 */
import { Socket } from 'node:net';

import { fromReadable } from '@effect/platform-node/NodeStream';
import { Config, Console, DateTime, Duration, Effect, Option, Schema, Stream } from 'effect';
import type { Redacted } from 'effect';

import { claimHostedModuleCredentials } from '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';
import {
  HostedModuleCredentialsSchema,
  ModuleAppIdSchema,
} from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import type { HostedModuleCredentialReceiver } from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';

export class ModuleCredentialHandoverError extends Schema.TaggedError<ModuleCredentialHandoverError>()(
  'ModuleCredentialHandoverError',
  { reason: Schema.String },
) {}

/**
 * The modules that call other modules through the Shell's delegated issuance, and so get a module credential. A test
 * derives the same list from source, so a new caller cannot be missed and a former one keeps no key.
 */
export const MODULE_CREDENTIAL_CALLERS: readonly string[] = Object.freeze([
  'catalog',
  'commerce-cart',
  'commerce-customer-context',
  'commerce-market-catalog',
  'commerce-order',
  'crm',
  'party-registry',
  'pricing',
]);

/**
 * Set to `fd3` by whoever starts a multi-owner process with its private handover channel open as file descriptor 3.
 * The switch is not secret; the keys travel only on that channel, never in an environment variable or argument.
 */
export const MODULE_CREDENTIAL_HANDOVER_VARIABLE = 'ONTOS_MODULE_CREDENTIAL_HANDOVER';

/** The private channel between a host and a process it starts: a pipe on file descriptor 3, beside stdout/stderr. */
export const MODULE_CREDENTIAL_CHANNEL_FD = 3;

const HandoverJsonSchema = Schema.fromJsonString(HostedModuleCredentialsSchema);

/** A module key's provider id: not secret, it names which bound credential a pass issued. */
const ProviderKeyIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ModuleProviderKeyId'));

/**
 * One handover message for one multi-owner process: exactly the given owners' credentials, nobody else's, as one
 * line on its channel. A process accepts messages for as long as the channel is open; each gives the named owners
 * their current key (a first key, a fresh one after a revocation, or a rotated one), replacing the one they held.
 */
export const encodeModuleCredentialHandover = Effect.fn('ModuleCredentials.encodeHandover')(function* encodeHandover(
  credentials: Readonly<Record<string, Redacted.Redacted>>,
  owners: readonly string[],
) {
  const json = yield* Schema.encodeEffect(HandoverJsonSchema)({
    credentials: Object.fromEntries(
      owners.flatMap((owner) => {
        const credential = credentials[owner];
        return credential === undefined ? [] : [[owner, credential] as const];
      }),
    ),
    schemaVersion: 1,
  }).pipe(Effect.mapError(() => new ModuleCredentialHandoverError({ reason: 'The handover could not be encoded' })));
  return new TextEncoder().encode(`${json}\n`);
});

/**
 * Applies the handover lines of one channel to this process's receiver, for as long as the channel stays open. A
 * malformed line is refused and reported by name only (never echoed: it may hold keys); the next line still counts.
 */
export const applyModuleCredentialHandovers = <E,>(
  receiver: HostedModuleCredentialReceiver,
  channel: Stream.Stream<Uint8Array, E>,
) =>
  channel.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    Stream.runForEach((line) =>
      Schema.decodeEffect(HandoverJsonSchema)(line).pipe(
        Effect.flatMap(receiver.accept),
        Effect.flatMap(({ accepted, refused }) => {
          const refusal = refused.length === 0 ? '' : `; refused ${refused.join(', ')} (not served here)`;
          return Console.log(
            `[module-credentials] received the credentials of ${accepted.join(', ') || 'no owner'}${refusal}`,
          );
        }),
        Effect.catchTag('SchemaError', () =>
          Console.error('[module-credentials] refused a malformed module credential handover'),
        ),
      ),
    ),
  );

/**
 * Claims this multi-owner process for `owners` before any owner runs. With the handover switch it keeps reading its
 * private channel (file descriptor 3) in the background, so the host can hand over keys at start and replace them
 * later (a late key, a fresh key after a revocation, a rotation), without a restart; without it, no owner ever holds
 * a key and none falls back to a module key in the shared environment.
 */
export const receiveModuleCredentialHandover = Effect.fn('ModuleCredentials.receiveHandover')(function* receive(
  owners: readonly string[],
) {
  const mode = yield* Config.option(Config.schema(Schema.Literal('fd3'), MODULE_CREDENTIAL_HANDOVER_VARIABLE)).pipe(
    Effect.mapError(
      () => new ModuleCredentialHandoverError({ reason: `${MODULE_CREDENTIAL_HANDOVER_VARIABLE} must be fd3` }),
    ),
  );
  const receiver = yield* claimHostedModuleCredentials(owners);
  if (Option.isNone(mode)) {
    return yield* Console.log('[module-credentials] no handover channel; no owner of this process holds a key');
  }
  const channel = fromReadable<Uint8Array, ModuleCredentialHandoverError>({
    // The channel is a pipe (a socket pair, or the local demo's FIFO); it is read as a stream, never seeked.
    evaluate: () => new Socket({ fd: MODULE_CREDENTIAL_CHANNEL_FD, readable: true, writable: false }),
    onError: () => new ModuleCredentialHandoverError({ reason: 'The handover channel could not be read' }),
  });
  yield* applyModuleCredentialHandovers(receiver, channel).pipe(
    Effect.catchTag('ModuleCredentialHandoverError', (problem) =>
      Console.error(`[module-credentials] ${problem.reason}`),
    ),
    Effect.forkScoped,
  );
  return yield* Effect.void;
});

/** One issued key, not secret: its provider id (which decides what is superseded) and when it stops verifying. */
const IssuedModuleKeySchema = Schema.Struct({
  expiresAt: Schema.DateTimeUtcFromString,
  providerKeyId: ProviderKeyIdSchema,
});

/**
 * What one provisioning pass writes to its private channel for the process that runs it: each module's fresh key,
 * each issued key's provider id and end of life, and the modules that got no key. A host keeps the same shape for
 * what it holds now.
 */
export const ProvisioningOutputSchema = Schema.Struct({
  credentials: HostedModuleCredentialsSchema.fields.credentials,
  failedAppIds: Schema.Array(ModuleAppIdSchema),
  keys: Schema.Record(Schema.String, IssuedModuleKeySchema),
  schemaVersion: Schema.Literal(1),
});
export type ProvisioningOutput = typeof ProvisioningOutputSchema.Type;

/** The provider key ids a pass issued, or a host holds. */
export const providerKeyIdsOf = (output: ProvisioningOutput): readonly string[] =>
  Object.values(output.keys).map(({ providerKeyId }) => providerKeyId);

/** The earliest end of life among the keys a host holds, in epoch milliseconds; `undefined` when it holds none. */
export const earliestExpiryOf = (output: ProvisioningOutput): number | undefined => {
  const ends = Object.values(output.keys).map(({ expiresAt }) => DateTime.toEpochMillis(expiresAt));
  return ends.length === 0 ? undefined : Math.min(...ends);
};

/** The wire form of a provisioning pass's output. */
export const ProvisioningOutputJsonSchema = Schema.fromJsonString(ProvisioningOutputSchema);

/** No pass ran: every caller is left without a key and its delegated calls fail closed. */
export const noProvisionedCredentials = (appIds: readonly string[]): ProvisioningOutput => ({
  credentials: {},
  failedAppIds: appIds.map((appId) => ModuleAppIdSchema.make(appId)),
  keys: {},
  schemaVersion: 1,
});

/**
 * How long a process may finish delegated calls it already started with a key that is being replaced: after another
 * host took the authority, after this host handed its owners rotated keys, and after it restarted.
 */
export const MODULE_CREDENTIAL_HANDOVER_GRACE = Duration.minutes(2);

/** How long before its keys end a host rotates them; with the 24-hour lifetime, a key is rotated at about 16 hours. */
export const MODULE_CREDENTIAL_ROTATION_LEAD = Duration.hours(8);
