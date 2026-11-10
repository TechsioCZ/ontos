import { ConfigProvider, Deferred, Effect, Option, Redacted, Schema } from 'effect';

import { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

export { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

/** A topology app id, the identity a module credential is bound to. */
export const ModuleAppIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u)).pipe(
  Schema.brand('ModuleAppId'),
);

/** The variable every module deployment reads as its own module credential. */
export const MODULE_CREDENTIAL_VARIABLE = 'ONTOS_GATEWAY_MODULE_API_KEY';

const MINIMUM_KEY_LENGTH = 16;

/**
 * What a host hands a process that serves several owners: owners' module credentials, keyed by app id. It travels on
 * that process's private handover channel and is kept only in its memory, never in an environment variable.
 */
export const HostedModuleCredentialsSchema = Schema.Struct({
  credentials: Schema.Record(
    Schema.String,
    Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
  ).check(
    // Refuse rather than drop: a handover naming something other than a topology app id is not this host's.
    Schema.makeFilter((credentials) =>
      Object.keys(credentials).every(Schema.is(ModuleAppIdSchema)) ? undefined : 'Credentials are keyed by app id',
    ),
  ),
  schemaVersion: Schema.Literal(1),
});
export type HostedModuleCredentials = typeof HostedModuleCredentialsSchema.Type;

/** What one handover changed: the owners whose empty slot it filled, and the entries it refused. */
export interface HostedModuleCredentialAcceptance {
  readonly accepted: readonly string[];
  readonly refused: readonly string[];
}

/** The one receiver of a multi-owner process: only the host code that claimed it can fill the owners' slots. */
export interface HostedModuleCredentialReceiver {
  readonly accept: (handover: HostedModuleCredentials) => Effect.Effect<HostedModuleCredentialAcceptance>;
  readonly owners: readonly string[];
}

/**
 * This process's hosted module credentials, private to this module: no global handle reaches them. Claiming the
 * process completes `hostedClaim` once with one write-once slot per served owner; only the claimed receiver fills a
 * slot, and an owner reads only its own slot through `moduleCredentialConfigProvider`. Every owner bundle of the
 * process resolves `@app/core-runtime` to this same module file, so they all share these slots
 * (`scripts/tests/hosted-module-credential-instance.test.mts`). The isolation between owners of one process is
 * cooperative: see DEPLOYMENT.md, "Module credentials and bindings".
 */
const hostedClaim = Deferred.makeUnsafe<ReadonlyMap<string, Deferred.Deferred<Redacted.Redacted>>>();

/**
 * Claims this process as a multi-owner host serving `owners`, before any owner runs. From then on each owner reads
 * only its own slot, which starts empty, and never a module key from the shared environment. Claiming twice is
 * refused, so code that runs later cannot obtain a receiver.
 */
export const claimHostedModuleCredentials = Effect.fn('HostedModuleCredentials.claim')(function* claim(
  owners: readonly string[],
) {
  const slots: ReadonlyMap<string, Deferred.Deferred<Redacted.Redacted>> = new Map(
    [...new Set(owners)].map((owner) => [owner, Deferred.makeUnsafe<Redacted.Redacted>()] as const),
  );
  if (!(yield* Deferred.succeed(hostedClaim, slots))) {
    return yield* new HostedModuleCredentialsSealedError({
      reason: 'This process already claimed its hosted module credentials',
    });
  }
  const accept = Effect.fn('HostedModuleCredentials.accept')(function* accept(handover: HostedModuleCredentials) {
    const entries = Object.entries(handover.credentials);
    // A slot is written once: a later handover fills only owners that still hold none, never replaces a key.
    const filled = yield* Effect.forEach(
      entries,
      ([owner, credential]) => {
        const slot = slots.get(owner);
        return slot === undefined ? Effect.succeed(false) : Deferred.succeed(slot, credential);
      },
      { concurrency: 1 },
    );
    return {
      accepted: entries.flatMap(([owner], index) => (filled[index] === true ? [owner] : [])),
      refused: entries.flatMap(([owner], index) => (filled[index] === true ? [] : [owner])),
    } satisfies HostedModuleCredentialAcceptance;
  });
  return { accept, owners: [...slots.keys()] } satisfies HostedModuleCredentialReceiver;
});

/** The owner's slot of a claimed process: `none` when the process serves one module, else its key if it holds one. */
const hostedSlot = Effect.fn('HostedModuleCredentials.hostedSlot')(function* readHostedSlot(appId: string) {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return Option.none<Option.Option<Redacted.Redacted>>();
  }
  const slot = (yield* claim.value).get(appId);
  const held = slot === undefined ? Option.none() : yield* Deferred.poll(slot);
  return Option.some(Option.isNone(held) ? Option.none<Redacted.Redacted>() : Option.some(yield* held.value));
});

/** Which owners of this host hold a credential now; names only, never a key. */
export const heldHostedModuleCredentials = Effect.gen(function* heldCredentials() {
  const claim = yield* Deferred.poll(hostedClaim);
  if (Option.isNone(claim)) {
    return [];
  }
  return [...(yield* claim.value).entries()].flatMap(([owner, slot]) => (Deferred.isDoneUnsafe(slot) ? [owner] : []));
});

const credentialValue = (credential: Option.Option<Redacted.Redacted>) =>
  Option.isNone(credential) ? undefined : ConfigProvider.makeValue(Redacted.value(credential.value));

/**
 * The configuration one owner reads, given how to read its hosted slot. In a multi-owner host
 * `ONTOS_GATEWAY_MODULE_API_KEY` resolves to that owner's own slot and to nothing else, never to the shared
 * environment. Without a claim the process serves one module (a dedicated deployment) and reads its own environment,
 * as every module deployment does. All other keys resolve exactly as the given provider resolves them. The slot is
 * read on every lookup, so a key handed over later is seen.
 */
const slotConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  slot: Effect.Effect<Option.Option<Option.Option<Redacted.Redacted>>>,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    path.length === 1 && path[0] === MODULE_CREDENTIAL_VARIABLE
      ? slot.pipe(
          Effect.flatMap((hosted) =>
            Option.isNone(hosted) ? host.load(path) : Effect.succeed(credentialValue(hosted.value)),
          ),
        )
      : host.load(path),
  );

/** The same configuration over a given set of hosted credentials (`null`: the process serves one module). */
export const ownerModuleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
  slots: () => ReadonlyMap<string, Redacted.Redacted> | null,
): ConfigProvider.ConfigProvider =>
  slotConfigProvider(
    host,
    Effect.sync(() => {
      const hosted = slots();
      return hosted === null ? Option.none() : Option.some(Option.fromNullishOr(hosted.get(appId)));
    }),
  );

/**
 * The owner's configuration in this process: its own slot when the process hosts several owners. The delegated
 * gateway client reads every module credential through it (`acquireDelegatedGatewayContext`), with the calling
 * module's app id, so no runtime, worker or background fiber can reach another owner's key by context.
 */
export const moduleCredentialConfigProvider = (
  host: ConfigProvider.ConfigProvider,
  appId: string,
): ConfigProvider.ConfigProvider => slotConfigProvider(host, hostedSlot(appId));
