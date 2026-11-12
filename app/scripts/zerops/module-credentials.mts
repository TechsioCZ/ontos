/**
 * The platform's module credentials on a host: who gets one, how a provisioning pass reports them, and how a process
 * that serves several owners receives them. Keys travel only over pipes between processes and live only in their
 * memory; they are never logged, written to disk or put in an environment variable. A process's channel is its file
 * descriptor 3; its standard output and standard error stay logs, so a stray log line never reaches a handover.
 */
import { Socket } from 'node:net';

import { fromReadable } from '@effect/platform-node/NodeStream';
import {
  Config,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import type { Redacted } from 'effect';

import { claimHostedModuleCredentials } from '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';
import {
  HostedModuleCredentialsSchema,
  ModuleAppIdSchema,
  workloadEntryAppId,
  WorkloadCredentialsSchema,
} from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import type {
  HostedModuleCredentialReceiver,
  HostedModuleCredentials,
} from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import type { HostedModuleCredentialsSealedError } from '../../packages/core-runtime/src/auth/hosted-module-credentials-sealed-error.ts';

export class ModuleCredentialHandoverError extends Schema.TaggedError<ModuleCredentialHandoverError>()(
  'ModuleCredentialHandoverError',
  { reason: Schema.String },
) {}

/**
 * The internal workloads (O73) a calling module runs as itself: a workload key the module's own Actions declare and its
 * own server acts as. Where the operator registered a principal for one (in a tenant), the platform issues that
 * principal's key next to the module key and hands it to the module, which then authenticates as the registered
 * workload exactly as before; nobody issues or copies such a key by hand.
 */
export const MODULE_INTERNAL_WORKLOADS: ReadonlyMap<string, readonly string[]> = new Map([
  ['crm', ['demo.crm.party-intake']],
]);

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
 * Set by whoever starts a multi-owner process with its private handover channel open as file descriptor 3. The switch
 * is not secret; the keys travel only on that channel, never in an environment variable or argument.
 *
 * - `fd3`: a launcher that may hand over and then close its side (the local demo); the end of the channel is not a
 *   failure.
 * - `fd3-lifetime`: the app host, which keeps the channel open for as long as it lives. The end of the channel means
 *   the host is gone (the kernel closes its side even when it is killed), so the process stops instead of serving on
 *   as an orphan with keys nobody rotates any more.
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
  workloads: Readonly<Record<string, Redacted.Redacted>> = {},
) {
  const ownWorkloads = Object.entries(workloads).filter(([entry]) => owners.includes(workloadEntryAppId(entry)));
  const json = yield* Schema.encodeEffect(HandoverJsonSchema)({
    credentials: Object.fromEntries(
      owners.flatMap((owner) => {
        const credential = credentials[owner];
        return credential === undefined ? [] : [[owner, credential] as const];
      }),
    ),
    schemaVersion: 1,
    workloads: Object.fromEntries(ownWorkloads),
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
 * Reads one process's channel for as long as it is open. A malformed line is refused and the channel still counts,
 * and its end (a launcher that handed over once and closed it, as the local demo's Outbox pipe does) is not a failure.
 * A channel that can no longer be read is: the host keeps renewing and rotating keys and retires the replaced ones,
 * so a process that silently stopped reading would soon hold only retired keys. It runs `lost` instead.
 */
export const watchModuleCredentialChannel = <E, R>(
  receiver: HostedModuleCredentialReceiver,
  channel: Stream.Stream<Uint8Array, E>,
  lost: (reason: string) => Effect.Effect<void, never, R>,
  ends: 'may-end' | 'lives-with-launcher' = 'may-end',
) =>
  applyModuleCredentialHandovers(receiver, channel).pipe(
    Effect.exit,
    Effect.flatMap((read) => {
      if (Exit.isFailure(read)) {
        return lost('the handover channel could not be read');
      }
      // A channel that lives with its launcher ends only when the launcher (the app host) is gone.
      return ends === 'lives-with-launcher' ? lost('the host closed the handover channel; it has ended') : Effect.void;
    }),
  );

/**
 * Fails once this process's channel can no longer be read. The process's entry stops on it (the owners process's
 * command, the Outbox Worker host's watch), the app host treats that process's exit as fatal and stops, and Zerops
 * restarts the container: a restart, with fresh keys on a fresh channel, rather than a process whose delegated calls
 * fail closed once the host retires the keys it still holds. Until then it never completes.
 */
const channelLost = Deferred.makeUnsafe<never, ModuleCredentialHandoverError>();
export const moduleCredentialChannelLost: Effect.Effect<never, ModuleCredentialHandoverError> =
  Deferred.await(channelLost);

const leaveProcess = (reason: string) =>
  Console.error(`[module-credentials] HANDOVER CHANNEL LOST (${reason}); this process stops so the host restarts`).pipe(
    Effect.andThen(Deferred.fail(channelLost, new ModuleCredentialHandoverError({ reason }))),
    Effect.asVoid,
  );

/**
 * What a process's host holds for the credential store copies it claimed. A process holds one copy per built bundle it
 * loaded (each owner bundle inlines its own), so the host claims each copy as it loads that bundle and registers it
 * here; every handover line then reaches every registered copy, and each copy takes only its own modules' keys. The
 * latest keys stay here too, so a copy registered after a line arrived (a unit loaded later) gets them at once.
 */
export interface HostedCredentialHolders {
  /** Registers one claimed copy and hands it the current keys of the modules it serves. */
  readonly hold: (copy: HostedModuleCredentialReceiver) => Effect.Effect<void>;
}

/** A handover's keys merged over what was held: each owner it names gets exactly its new key and workload keys. */
const mergeHandover = (held: HostedModuleCredentials, handover: HostedModuleCredentials): HostedModuleCredentials => {
  const named = new Set([
    ...Object.keys(handover.credentials),
    ...Object.keys(handover.workloads ?? {}).map(workloadEntryAppId),
  ]);
  return {
    credentials: { ...held.credentials, ...handover.credentials },
    schemaVersion: 1,
    workloads: {
      ...Object.fromEntries(
        Object.entries(held.workloads ?? {}).filter(([entry]) => !named.has(workloadEntryAppId(entry))),
      ),
      ...handover.workloads,
    },
  };
};

/**
 * The process's holders, for the modules it serves, and the one receiver its channel feeds. A line names keys of
 * modules this process serves (accepted: handed to their copies now, or once loaded) and of others (refused).
 */
export const makeHostedCredentialHolders = Effect.fn('ModuleCredentials.makeHolders')(function* makeHolders(
  owners: readonly string[],
) {
  const lock = yield* Semaphore.make(1);
  const copies = yield* Ref.make<readonly HostedModuleCredentialReceiver[]>([]);
  const held = yield* Ref.make<HostedModuleCredentials>({ credentials: {}, schemaVersion: 1, workloads: {} });
  const served = new Set(owners);
  const servedHere = (entry: string) => served.has(entry) || served.has(workloadEntryAppId(entry));
  const accept = (handover: HostedModuleCredentials) =>
    Semaphore.withPermits(
      lock,
      1,
    )(
      Effect.gen(function* acceptLine() {
        const entries = [...Object.keys(handover.credentials), ...Object.keys(handover.workloads ?? {})];
        const own: HostedModuleCredentials = {
          credentials: Object.fromEntries(Object.entries(handover.credentials).filter(([owner]) => served.has(owner))),
          schemaVersion: 1,
          workloads: Object.fromEntries(
            Object.entries(handover.workloads ?? {}).filter(([entry]) => servedHere(entry)),
          ),
        };
        yield* Ref.update(held, (current) => mergeHandover(current, own));
        yield* Effect.forEach(yield* Ref.get(copies), (copy) => copy.accept(own), { discard: true });
        return {
          accepted: entries.filter((entry) => servedHere(entry)),
          refused: entries.filter((entry) => !servedHere(entry)),
        };
      }),
    );
  const hold = (copy: HostedModuleCredentialReceiver) =>
    Semaphore.withPermits(
      lock,
      1,
    )(
      Effect.gen(function* holdCopy() {
        const current = yield* Ref.get(held);
        if (Object.keys(current.credentials).length > 0 || Object.keys(current.workloads ?? {}).length > 0) {
          yield* copy.accept(current);
        }
        yield* Ref.update(copies, (registered) => [...registered, copy]);
      }),
    );
  return {
    holders: { hold } satisfies HostedCredentialHolders,
    receiver: { accept, owners: [...served] } satisfies HostedModuleCredentialReceiver,
  };
});

/**
 * Starts receiving this process's keys for the modules it serves, before any of them loads: with the handover switch
 * it keeps reading its private channel (file descriptor 3) in the background, so the host can hand keys over at start
 * and replace them later (a late key, a fresh key after a revocation, a rotation) without a restart. The host program
 * then claims each loaded copy and registers it with the returned holders. Without the switch no copy ever holds a
 * key; there is no environment variable to read one from.
 */
export const receiveModuleCredentialHandover = Effect.fn('ModuleCredentials.receiveHandover')(function* receive(
  owners: readonly string[],
) {
  const mode = yield* Config.option(
    Config.schema(Schema.Literals(['fd3', 'fd3-lifetime']), MODULE_CREDENTIAL_HANDOVER_VARIABLE),
  ).pipe(
    Effect.mapError(
      () =>
        new ModuleCredentialHandoverError({
          reason: `${MODULE_CREDENTIAL_HANDOVER_VARIABLE} must be fd3 or fd3-lifetime`,
        }),
    ),
  );
  const { holders, receiver } = yield* makeHostedCredentialHolders(owners);
  if (Option.isNone(mode)) {
    yield* Console.log('[module-credentials] no handover channel; no owner of this process holds a key');
    return holders;
  }
  const channel = fromReadable<Uint8Array, ModuleCredentialHandoverError>({
    // The channel is a pipe (a socket pair, or the local demo's FIFO); it is read as a stream, never seeked.
    evaluate: () => new Socket({ fd: MODULE_CREDENTIAL_CHANNEL_FD, readable: true, writable: false }),
    onError: () => new ModuleCredentialHandoverError({ reason: 'The handover channel could not be read' }),
  });
  yield* watchModuleCredentialChannel(
    receiver,
    channel,
    leaveProcess,
    mode.value === 'fd3-lifetime' ? 'lives-with-launcher' : 'may-end',
  ).pipe(Effect.forkScoped);
  return holders;
});

/**
 * Claims the store copy this host program itself carries and registers it: for a process whose owners run inside the
 * host program's own bundle (the Outbox Worker host's `worker.mjs`, one bundle with one copy).
 */
export const holdOwnStoreCopy = Effect.fn('ModuleCredentials.holdOwnCopy')(function* holdOwnCopy(
  holders: HostedCredentialHolders,
  owners: readonly string[],
) {
  yield* holders.hold(yield* claimHostedModuleCredentials(owners));
});

/** A loaded unit's claim: the generated entry's re-export of its own bundle's store copy claim. */
export type UnitCredentialClaim = (
  owners: readonly string[],
) => Effect.Effect<HostedModuleCredentialReceiver, HostedModuleCredentialsSealedError>;

/** A loaded module's claim export, as the bundle's `claimHostedModuleCredentials` is: a function. */
const isUnitCredentialClaim = (cause: unknown): cause is UnitCredentialClaim => Predicate.isFunction(cause);
export const UnitCredentialClaimSchema = Schema.declare(isUnitCredentialClaim);

/**
 * Claims one loaded bundle's copy for its module, through the claim the unit's entry exported, and registers it. The
 * claim is the bundle's own one-time claim: a second call is refused, so code that runs later obtains no receiver.
 */
export const holdUnitStoreCopy = Effect.fn('ModuleCredentials.holdUnitCopy')(function* holdUnitCopy(
  holders: HostedCredentialHolders,
  unit: string,
  claim: UnitCredentialClaim,
) {
  const copy = yield* claim([unit]).pipe(
    Effect.mapError(
      () => new ModuleCredentialHandoverError({ reason: `${unit}'s credential store copy was already claimed` }),
    ),
  );
  yield* holders.hold(copy);
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
  /** The served modules' internal workload credentials, by `<app id>/<workload key>/<tenant id>`. */
  workloadCredentials: WorkloadCredentialsSchema,
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
  workloadCredentials: {},
});

/**
 * How long a process may finish delegated calls it already started with a key that is being replaced: after another
 * host took the authority, after this host handed its owners rotated keys, and after it restarted.
 */
export const MODULE_CREDENTIAL_HANDOVER_GRACE = Duration.minutes(2);

/** How long before its keys end a host rotates them; with the 24-hour lifetime, a key is rotated at about 16 hours. */
export const MODULE_CREDENTIAL_ROTATION_LEAD = Duration.hours(8);
